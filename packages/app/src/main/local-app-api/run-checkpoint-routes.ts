// Startup checkpoint discovery, inspection, abandonment and streamed continuation.

import { randomUUID } from 'node:crypto'
import type { AgentRunner, RunnerResult } from '@littlesheep/runner'
import type { PermissionModeId } from '../../shared/permission-modes.js'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import type {
  LocalAppRunCheckpointAbandonResponse,
  LocalAppRunCheckpointInspectResponse,
  LocalAppRunCheckpointListResponse,
  LocalAppRunCheckpointResumeRequest,
} from '../../shared/run-checkpoint-contracts.js'
import { createPermissionApprover, type RunApprovalBroker } from '../run-policy.js'
import { json, openSse, readJson, writeSse, type LocalAppApiRequest } from './http.js'
import type { RunRouteContext } from './run-routes.js'
import {
  finishRunResources,
  resolveRunSessionOwnership,
  resolveRunWorkspaceContext,
} from './run-support.js'
import {
  pendingCheckpointHeads,
  toCheckpointDetail,
  toCheckpointDiagnostics,
  toCheckpointSummary,
} from './run-checkpoint-view.js'

const MAX_CHECKPOINTS_FOR_STARTUP = 128
const MAX_RESUME_REASON_LENGTH = 1_024
const MAX_CLARIFICATION_TEXT_LENGTH = 16 * 1024

export interface RunCheckpointRouteHost {
  registerActive(runId: string, runner: AgentRunner, controller: AbortController): boolean
  releaseActive(runId: string, runner: AgentRunner, controller: AbortController): void
  isRunActive(runId: string): boolean
  createApprovalBroker(
    publish: (request: Parameters<RunApprovalBroker>[0] & { id: string; source: 'agent' }) => void,
    signal: AbortSignal,
  ): RunApprovalBroker
}

export async function routeRunCheckpoints(
  request: LocalAppApiRequest,
  context: RunRouteContext,
  host: RunCheckpointRouteHost,
): Promise<boolean> {
  const { req, res, path, method } = request
  const runner = context.getRunner()
  const control = runner.runCheckpoints

  if (method === 'GET' && path === LOCAL_APP_API_ROUTES.runCheckpoints) {
    if (!control) {
      json(res, 503, { error: 'runtime checkpoint storage is unavailable' })
      return true
    }
    const inspections = pendingCheckpointHeads(await control.list(MAX_CHECKPOINTS_FOR_STARTUP))
    const response: LocalAppRunCheckpointListResponse = {
      checkpoints: inspections.map(toCheckpointSummary),
      diagnostics: toCheckpointDiagnostics(control.diagnostics()),
    }
    json(res, 200, response)
    return true
  }

  const resumeId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.runCheckpoints, '/resume/stream')
  if (method === 'POST' && resumeId !== null) {
    if (!control || !runner.resumeCheckpoint) {
      json(res, 503, { error: 'runtime checkpoint continuation is unavailable' })
      return true
    }
    const body = await readJson(req) as LocalAppRunCheckpointResumeRequest
    const inspection = await control.inspect(resumeId)
    if (!inspection) {
      json(res, 404, { error: `run checkpoint not found: ${resumeId}` })
      return true
    }
    if (!inspection.resumable) {
      json(res, 409, { error: `run checkpoint cannot be resumed: ${inspection.reasons.join('; ')}` })
      return true
    }
    const text = parseBoundedOptional(body.text, MAX_CLARIFICATION_TEXT_LENGTH)
    if (!text.ok) {
      json(res, 400, { error: text.error })
      return true
    }
    if (inspection.checkpoint.status === 'waiting_user' && !text.value) {
      json(res, 400, { error: 'run checkpoint is waiting for a user clarification' })
      return true
    }
    const parsedReason = parseBoundedOptional(body.reason, MAX_RESUME_REASON_LENGTH)
    if (!parsedReason.ok) {
      json(res, 400, { error: parsedReason.error })
      return true
    }
    const reason = parsedReason.value
      ?? 'user requested checkpoint continuation from the desktop app'
    return streamCheckpointResume(request, context, host, runner, resumeId, text.value, reason)
  }

  const abandonId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.runCheckpoints, '/abandon')
  if (method === 'POST' && abandonId !== null) {
    if (!control) {
      json(res, 503, { error: 'runtime checkpoint storage is unavailable' })
      return true
    }
    const inspection = await control.inspect(abandonId)
    if (!inspection) {
      json(res, 404, { error: `run checkpoint not found: ${abandonId}` })
      return true
    }
    const activeResumeRunId = inspection.disposition?.status === 'resuming'
      ? inspection.disposition.resumeRunId
      : undefined
    if (activeResumeRunId && host.isRunActive(activeResumeRunId)) {
      json(res, 409, { error: 'run checkpoint is currently resuming; stop that run before abandoning it' })
      return true
    }
    const body = await readJson(req)
    const parsedReason = parseBoundedOptional(body.reason, MAX_RESUME_REASON_LENGTH)
    if (!parsedReason.ok) {
      json(res, 400, { error: parsedReason.error })
      return true
    }
    const reason = parsedReason.value
      ?? 'user abandoned checkpoint from the desktop app'
    const outcome = await control.abandon(abandonId, reason)
    if (outcome.kind === 'conflict') {
      json(res, 409, { error: outcome.message })
      return true
    }
    const response: LocalAppRunCheckpointAbandonResponse = {
      checkpointId: abandonId,
      outcome: outcome.kind === 'duplicate' ? 'duplicate' : 'abandoned',
    }
    json(res, 200, response)
    return true
  }

  const inspectId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.runCheckpoints)
  if (method === 'GET' && inspectId !== null) {
    if (!control) {
      json(res, 503, { error: 'runtime checkpoint storage is unavailable' })
      return true
    }
    const inspection = await control.inspect(inspectId)
    if (!inspection) {
      json(res, 404, { error: `run checkpoint not found: ${inspectId}` })
      return true
    }
    const response: LocalAppRunCheckpointInspectResponse = {
      checkpoint: toCheckpointDetail(inspection),
    }
    json(res, 200, response)
    return true
  }

  return false
}

async function streamCheckpointResume(
  request: LocalAppApiRequest,
  context: RunRouteContext,
  host: RunCheckpointRouteHost,
  runner: AgentRunner,
  checkpointId: string,
  text: string | undefined,
  reason: string,
): Promise<true> {
  const { req, res } = request
  const inspection = await runner.runCheckpoints!.inspect(checkpointId)
  const state = inspection?.checkpoint.resumeState
  if (!inspection || !state) {
    json(res, 409, { error: 'run checkpoint has no resumable runtime state' })
    return true
  }
  const runId = randomUUID()
  const controller = new AbortController()
  if (!host.registerActive(runId, runner, controller)) {
    json(res, 429, { error: 'too many active agent runs' })
    return true
  }
  const stopHeartbeat = openSse(res)
  writeSse(res, 'start', { ok: true, runId, resumedFromCheckpointId: checkpointId })
  try {
    const ownership = await resolveRunSessionOwnership(context.sessionIndex, context.projectIndex, {
      sessionId: String(inspection.checkpoint.sessionId),
    })
    const workspaceContext = state.workspaceContext
      ?? resolveRunWorkspaceContext(state.cwd, ownership, context.workplaceDir)
    const approvalBroker = host.createApprovalBroker(
      (approval) => writeSse(res, 'approval_request', approval),
      controller.signal,
    )
    const approve = createPermissionApprover(
      state.permissionPolicyId as PermissionModeId,
      approvalBroker,
      { containerRoot: context.dataDir ?? context.workplaceDir, cwd: state.cwd },
    )
    const result = await runner.resumeCheckpoint!(checkpointId, {
      runId,
      text,
      reason,
      signal: controller.signal,
      approve,
      onAssistantDelta: (delta) => writeSse(res, 'delta', { delta }),
      onAssistantReplace: (replacement) => writeSse(res, 'replace', { text: replacement }),
      onToolEvent: (event) => writeSse(res, event.type, event),
    })
    if (result.runId !== runId) throw new Error('runner returned an unexpected resumed run id')
    await finishRunResources(context, runner, result, {
      sessionId: String(inspection.checkpoint.sessionId),
    }, ownership, state.cwd, workspaceContext)
    writeSse(res, 'result', result)
  } catch (error) {
    writeSse(res, 'error', { error: error instanceof Error ? error.message : String(error) })
  } finally {
    stopHeartbeat()
    host.releaseActive(runId, runner, controller)
    res.end()
  }
  return true
}

function parseBoundedOptional(
  value: unknown,
  maximum: number,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'string') return { ok: false, error: 'checkpoint action text must be a string' }
  const normalized = value.trim()
  if (!normalized) return { ok: true }
  if (normalized.length > maximum) return { ok: false, error: `checkpoint action text exceeds ${maximum} characters` }
  return { ok: true, value: normalized }
}
