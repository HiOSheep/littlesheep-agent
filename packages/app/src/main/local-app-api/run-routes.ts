// Agent run, streaming, approval and run-owned resource lifecycle routes.

import { randomUUID } from 'node:crypto'
import type { Config } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { asSessionId, type RuntimeEventIngressOutcome } from '@littlesheep/types'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  matchLocalAppApiItemPath,
} from '../../shared/local-app-api-routes.js'
import {
  isLocalAppRuntimeControlEventType,
  isLocalAppRuntimeTaskEventType,
  type LocalAppRuntimeControlEventResponse,
  type LocalAppRuntimeTaskEventResponse,
} from '../../shared/runtime-event-contracts.js'
import {
  createInspectAttachmentTool,
  parseAttachments,
  prepareRunAttachments,
} from '../attachments.js'
import type { ManagedAttachmentCache } from '../attachment-cache.js'
import type { ProjectIndex } from '../project-index.js'
import { resolveRunPolicy, type RunApprovalBroker, type RunApprovalRequest } from '../run-policy.js'
import type { SessionIndex } from '../session-index.js'
import type { WorkspaceArtifactIndex } from '../workspace-artifact-index.js'
import { json, readJson, writeSse, type LocalAppApiRequest } from './http.js'
import { resolveReasoning } from './runtime-routes.js'
import {
  appendAgentArtifacts,
  resolveRunSessionOwnership,
  resolveRunWorkspace,
  resolveRunWorkspaceContext,
  updateSessionIndex,
} from './run-support.js'
import { syncWorkspaceResourceChanges } from './workspace-support.js'

const MAX_ACTIVE_STREAM_RUNS = 16
const MAX_PENDING_APPROVALS = 64
const RUNTIME_EVENT_REGISTRATION_WAIT_MS = 2_000
const RUNTIME_EVENT_REGISTRATION_POLL_MS = 20
const MAX_RUNTIME_EVENT_REASON_LENGTH = 1_024
const MAX_RUNTIME_EVENT_ID_LENGTH = 256
const MAX_RUNTIME_EVENT_DEDUP_KEY_LENGTH = 512
const MAX_RUNTIME_EVENT_PAYLOAD_KEYS = 64
const MAX_RUNTIME_EVENT_TEXT_LENGTH = 16 * 1024
const MAX_RUNTIME_EVENT_PATH_LENGTH = 4_096

interface PendingApproval {
  resolve: (approved: boolean) => void
  cleanup: () => void
}

interface ActiveStreamRun {
  controller: AbortController
  runner: AgentRunner
}

interface ApprovalRequestPayload extends RunApprovalRequest {
  id: string
  source: 'agent'
}

type RuntimeEventInput = Parameters<AgentRunner['runtimeEvents']['append']>[1]

export interface RunRouteContext {
  getRunner: () => AgentRunner
  getConfig: () => Config
  /** Active movable application-data root; defines the logical LS container. */
  dataDir?: string
  workplaceDir: string
  sessionIndex: SessionIndex
  projectIndex: ProjectIndex
  workspaceArtifactIndex: WorkspaceArtifactIndex
  attachmentCache: ManagedAttachmentCache
}

export class RunRouter {
  private readonly activeStreams = new Map<string, ActiveStreamRun>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()

  async route(request: LocalAppApiRequest, context: RunRouteContext): Promise<boolean> {
    const { req, res, path, method } = request

    const approvalId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.approvals)
    if (method === 'POST' && approvalId !== null) {
      const body = await readJson(req)
      const pending = this.pendingApprovals.get(approvalId)
      if (!pending) {
        json(res, 404, { error: `approval request not found: ${approvalId}` })
        return true
      }
      this.pendingApprovals.delete(approvalId)
      pending.cleanup()
      pending.resolve(body.approved === true)
      json(res, 200, { ok: true })
      return true
    }

    const runtimeEventRunId = matchLocalAppApiItemPath(path, LOCAL_APP_API_PREFIXES.runs, '/events')
    if (method === 'POST' && runtimeEventRunId !== null) {
      const active = this.activeStreams.get(runtimeEventRunId)
      if (!active) {
        json(res, 404, { error: `active run not found: ${runtimeEventRunId}` })
        return true
      }
      const body = await readJson(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        json(res, 400, { error: 'runtime control event body must be a JSON object' })
        return true
      }
      if (isLocalAppRuntimeControlEventType(body.type)) {
        if (body.reason !== undefined && typeof body.reason !== 'string') {
          json(res, 400, { error: 'runtime event reason must be a string' })
          return true
        }
        const reason = typeof body.reason === 'string'
          ? body.reason.trim().slice(0, MAX_RUNTIME_EVENT_REASON_LENGTH)
          : ''
        const outcome = await this.appendRuntimeEvent(request, active, runtimeEventRunId, {
          type: body.type,
          source: 'app',
          payload: reason ? { reason } : {},
        })
        const response: LocalAppRuntimeControlEventResponse = {
          runId: runtimeEventRunId,
          outcome,
          summary: active.runner.runtimeEvents.summary(runtimeEventRunId),
        }
        json(res, outcome.kind === 'rejected' ? 409 : 202, response)
        return true
      }

      if (isLocalAppRuntimeTaskEventType(body.type)) {
        const parsed = parseRuntimeTaskEventBody(body)
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error })
          return true
        }
        const outcome = await this.appendRuntimeEvent(request, active, runtimeEventRunId, parsed.input)
        const response: LocalAppRuntimeTaskEventResponse = {
          runId: runtimeEventRunId,
          outcome,
          summary: active.runner.runtimeEvents.summary(runtimeEventRunId),
        }
        json(res, outcome.kind === 'rejected' ? 409 : 202, response)
        return true
      }

      json(res, 400, { error: 'unsupported runtime event type' })
      return true
    }

    if (method === 'POST' && path === LOCAL_APP_API_ROUTES.runStream) {
      if (this.activeStreams.size >= MAX_ACTIVE_STREAM_RUNS) {
        json(res, 429, { error: 'too many active agent runs' })
        return true
      }
      const body = await readJson(req)
      const runId = randomUUID()
      const controller = new AbortController()
      const runner = context.getRunner()
      const active: ActiveStreamRun = { controller, runner }
      this.activeStreams.set(runId, active)
      let completed = false
      const abortOnDisconnect = () => {
        if (!completed) controller.abort()
      }
      req.once('aborted', abortOnDisconnect)
      res.once('close', abortOnDisconnect)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // Let the renderer show the run immediately while workspace and
      // attachment preparation continues asynchronously below.
      writeSse(res, 'start', { ok: true, runId })
      try {
        const cwd = resolveRunWorkspace(body, context.getConfig(), context.workplaceDir)
        const ownership = await resolveRunSessionOwnership(context.sessionIndex, context.projectIndex, body)
        const workspaceContext = resolveRunWorkspaceContext(cwd, ownership, context.workplaceDir)
        const attachments = await prepareRunAttachments(parseAttachments(body.attachments), {
          managedCache: context.attachmentCache,
          workplaceDir: context.workplaceDir,
          workspaceDir: cwd,
          projectId: ownership.projectId,
        })
        const inspectAttachmentTool = createInspectAttachmentTool(attachments)
        // Publish the run identity before Runner can emit step/tool deltas.
        // A synchronous portion of a runner may produce events immediately;
        // the renderer must be able to address the run for interruption from
        // the first streamed frame onward.
        const runPromise = runner.runStream(
          {
            runId,
            text: String(body.text ?? ''),
            sessionId: body.sessionId ? asSessionId(String(body.sessionId)) : undefined,
            origin: 'app',
            cwd,
            reasoning: resolveReasoning(body, context.getConfig()),
            attachments,
            additionalTools: inspectAttachmentTool ? [inspectAttachmentTool] : undefined,
            workspaceContext,
            signal: controller.signal,
            onToolEvent: (event) => writeSse(res, event.type, event),
            onAssistantReplace: (text) => writeSse(res, 'replace', { text }),
            ...resolveRunPolicy(
              body,
              context.getConfig(),
              this.buildApprovalBroker(
                (approval) => writeSse(res, 'approval_request', approval),
                controller.signal,
              ),
              { containerRoot: context.dataDir ?? context.workplaceDir, cwd },
            ),
          },
          (delta) => writeSse(res, 'delta', { delta }),
        )
        const result = await runPromise
        if (result.runId !== runId) throw new Error(`runner returned an unexpected run id: ${result.runId}`)
        await this.finishRun(context, runner, result, body, ownership, cwd, workspaceContext)
        writeSse(res, 'result', result)
      } catch (error) {
        writeSse(res, 'error', { error: (error as Error).message })
      } finally {
        completed = true
        req.removeListener('aborted', abortOnDisconnect)
        res.removeListener('close', abortOnDisconnect)
        if (this.activeStreams.get(runId) === active) this.activeStreams.delete(runId)
        res.end()
      }
      return true
    }

    if (method === 'POST' && path === LOCAL_APP_API_ROUTES.run) {
      const body = await readJson(req)
      const runner = context.getRunner()
      const cwd = resolveRunWorkspace(body, context.getConfig(), context.workplaceDir)
      const ownership = await resolveRunSessionOwnership(context.sessionIndex, context.projectIndex, body)
      const workspaceContext = resolveRunWorkspaceContext(cwd, ownership, context.workplaceDir)
      const attachments = await prepareRunAttachments(parseAttachments(body.attachments), {
        managedCache: context.attachmentCache,
        workplaceDir: context.workplaceDir,
        workspaceDir: cwd,
        projectId: ownership.projectId,
      })
      const inspectAttachmentTool = createInspectAttachmentTool(attachments)
      const result = await runner.run({
        text: String(body.text ?? ''),
        sessionId: body.sessionId ? asSessionId(String(body.sessionId)) : undefined,
        origin: 'app',
        cwd,
        reasoning: resolveReasoning(body, context.getConfig()),
        attachments,
        additionalTools: inspectAttachmentTool ? [inspectAttachmentTool] : undefined,
        workspaceContext,
        ...resolveRunPolicy(body, context.getConfig(), undefined, {
          containerRoot: context.dataDir ?? context.workplaceDir,
          cwd,
        }),
      })
      await this.finishRun(context, runner, result, body, ownership, cwd, workspaceContext)
      json(res, 200, result)
      return true
    }

    return false
  }

  stop(): void {
    for (const active of this.activeStreams.values()) active.controller.abort()
    this.activeStreams.clear()
    for (const pending of this.pendingApprovals.values()) {
      pending.cleanup()
      pending.resolve(false)
    }
    this.pendingApprovals.clear()
  }

  private async appendRuntimeEvent(
    request: LocalAppApiRequest,
    active: ActiveStreamRun,
    runId: string,
    input: Parameters<AgentRunner['runtimeEvents']['append']>[1],
  ): Promise<RuntimeEventIngressOutcome> {
    const deadline = Date.now() + RUNTIME_EVENT_REGISTRATION_WAIT_MS
    let requestAborted = request.req.aborted
    const markAborted = () => { requestAborted = true }
    request.req.once('aborted', markAborted)
    try {
      while (true) {
        if (requestAborted || this.activeStreams.get(runId) !== active) {
          return {
            kind: 'rejected',
            reason: 'run-not-active',
            message: `Run is no longer active: ${runId}`,
          }
        }
        const outcome = active.runner.runtimeEvents.append(runId, input)
        if (outcome.kind !== 'rejected' || outcome.reason !== 'run-not-active') return outcome
        if (Date.now() >= deadline) return outcome
        await delay(RUNTIME_EVENT_REGISTRATION_POLL_MS)
      }
    } finally {
      request.req.removeListener('aborted', markAborted)
    }
  }

  private async finishRun(
    context: RunRouteContext,
    runner: AgentRunner,
    result: Awaited<ReturnType<AgentRunner['run']>>,
    body: Record<string, unknown>,
    ownership: { scope: 'standalone' | 'project'; projectId?: string },
    cwd: string,
    workspaceContext: NonNullable<Parameters<AgentRunner['infra']['memoryService']['syncWorkspaceResources']>[1]>,
  ): Promise<void> {
    await updateSessionIndex(context.sessionIndex, result.sessionId, body, ownership, cwd)
    if (ownership.projectId) await context.projectIndex.touch(ownership.projectId)
    const artifacts = await appendAgentArtifacts(
      context.workspaceArtifactIndex,
      result,
      cwd,
      ownership.projectId,
    )
    if (artifacts.length > 0) {
      await syncWorkspaceResourceChanges(runner, cwd, {
        ...workspaceContext,
        changes: artifacts.map((artifact) => ({ path: artifact.path, source: 'agent' })),
      })
    }
  }

  private buildApprovalBroker(
    requestApproval: (request: ApprovalRequestPayload) => void,
    signal?: AbortSignal,
  ): RunApprovalBroker {
    return async ({ action, detail, permissionMode, boundary }) => {
      const id = randomUUID()
      return new Promise<boolean>((resolveApproval) => {
        let settled = false
        let timer: NodeJS.Timeout | undefined
        let onAbort: (() => void) | undefined
        const cleanup = () => {
          if (timer) clearTimeout(timer)
          if (onAbort) signal?.removeEventListener('abort', onAbort)
        }
        const settle = (allowed: boolean) => {
          if (settled) return
          settled = true
          cleanup()
          this.pendingApprovals.delete(id)
          resolveApproval(allowed)
        }
        onAbort = () => settle(false)
        timer = setTimeout(() => settle(false), 120_000)
        while (this.pendingApprovals.size >= MAX_PENDING_APPROVALS) {
          const oldest = this.pendingApprovals.values().next().value as PendingApproval | undefined
          if (!oldest) break
          oldest.cleanup()
          oldest.resolve(false)
        }
        this.pendingApprovals.set(id, { resolve: settle, cleanup })
        if (signal?.aborted) {
          settle(false)
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
          requestApproval({ id, action, detail, permissionMode, boundary, source: 'agent' })
        } catch {
          settle(false)
        }
      })
    }
  }
}

function parseRuntimeTaskEventBody(
  body: Record<string, unknown>,
): { ok: true; input: RuntimeEventInput } | { ok: false; error: string } {
  if (!isRecord(body.payload)) {
    if (body.payload !== undefined) return { ok: false, error: 'runtime task event payload must be a JSON object' }
  }
  const payload: Record<string, unknown> = isRecord(body.payload) ? { ...body.payload } : {}
  const type = body.type as RuntimeEventInput['type']

  if (body.text !== undefined) {
    if (typeof body.text !== 'string' || body.text.trim().length === 0 || body.text.length > MAX_RUNTIME_EVENT_TEXT_LENGTH) {
      return { ok: false, error: `runtime user message text must be a non-empty string under ${MAX_RUNTIME_EVENT_TEXT_LENGTH} characters` }
    }
    if (payload.text !== undefined && payload.text !== body.text) {
      return { ok: false, error: 'runtime user message text is duplicated with different values' }
    }
    payload.text = body.text
  }

  if (body.reason !== undefined) {
    if (typeof body.reason !== 'string' || body.reason.length > MAX_RUNTIME_EVENT_REASON_LENGTH) {
      return { ok: false, error: 'runtime event reason must be a bounded string' }
    }
    if (body.reason.trim() && payload.reason === undefined) payload.reason = body.reason.trim()
  }

  const patchKeys = ['taskBookPatch', 'patch'] as const
  const suppliedPatchKeys = patchKeys.filter((key) => body[key] !== undefined)
  if (suppliedPatchKeys.length > 1) {
    return { ok: false, error: 'runtime task event may contain only one of taskBookPatch or patch' }
  }
  if (suppliedPatchKeys.length === 1) {
    const key = suppliedPatchKeys[0]!
    if (!isRecord(body[key]) || payload[key] !== undefined) {
      return { ok: false, error: `${key} must be an object and must not be duplicated in payload` }
    }
    payload[key] = body[key]
  }

  if (type === 'user_message') {
    if (typeof payload.text !== 'string' || payload.text.trim().length === 0 || payload.text.length > MAX_RUNTIME_EVENT_TEXT_LENGTH) {
      return { ok: false, error: 'user_message requires a bounded non-empty payload.text' }
    }
  } else if (type === 'setting_changed') {
    if (typeof payload.key !== 'string' || payload.key.trim().length === 0 || payload.key.length > 512) {
      return { ok: false, error: 'setting_changed requires a bounded payload.key' }
    }
  } else if (type === 'workspace_file_saved') {
    if (typeof payload.path !== 'string' || payload.path.trim().length === 0 || payload.path.length > MAX_RUNTIME_EVENT_PATH_LENGTH) {
      return { ok: false, error: 'workspace_file_saved requires a bounded payload.path' }
    }
  }

  if (Object.keys(payload).length > MAX_RUNTIME_EVENT_PAYLOAD_KEYS) {
    return { ok: false, error: `runtime task event payload cannot contain more than ${MAX_RUNTIME_EVENT_PAYLOAD_KEYS} keys` }
  }

  const metadata = parseRuntimeEventMetadata(body)
  if (!metadata.ok) return metadata
  return {
    ok: true,
    input: {
      type,
      source: 'app',
      payload,
      ...metadata.value,
    },
  }
}

function parseRuntimeEventMetadata(
  body: Record<string, unknown>,
): { ok: true; value: Partial<RuntimeEventInput> } | { ok: false; error: string } {
  const value: Partial<RuntimeEventInput> = {}
  for (const [key, maximum] of [
    ['id', MAX_RUNTIME_EVENT_ID_LENGTH],
    ['dedupKey', MAX_RUNTIME_EVENT_DEDUP_KEY_LENGTH],
    ['receivedAt', 128],
    ['expiresAt', 128],
  ] as const) {
    const raw = body[key]
    if (raw === undefined) continue
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > maximum) {
      return { ok: false, error: `runtime event ${key} must be a bounded non-empty string` }
    }
    value[key] = raw.trim() as never
  }
  return { ok: true, value }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
