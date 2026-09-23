// Agent run, streaming, approval and run-owned resource lifecycle routes.

import { randomUUID } from 'node:crypto'
import type { Config } from '@littlesheep/config'
import { conversationTurnRunId, prepareAuthoritativeRunnerResult, type AgentRunner } from '@littlesheep/runner'
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
  createCheckpointResourceResolver,
  parseAttachments,
  prepareRunAttachments,
} from '../attachments.js'
import type { ManagedAttachmentCache } from '../attachment-cache.js'
import { ensureManagedAttachmentRefs } from '../attachment-materialization.js'
import type { ProjectIndex } from '../project-index.js'
import { resolveRunPolicy, type RunApprovalBroker, type RunApprovalRequest } from '../run-policy.js'
import type { SessionIndex } from '../session-index.js'
import type { WorkspaceArtifactIndex } from '../workspace-artifact-index.js'
import { json, openSse, readJson, resolveRunner, writeSse, type LocalAppApiRequest } from './http.js'
import { resolveReasoning } from './runtime-routes.js'
import {
  finishRunResources,
  resolveOwnedRunWorkspace,
  resolveRunSessionOwnership,
  resolveRunWorkspaceContext,
  withPersistedSessionPermissionMode,
} from './run-support.js'
import { routeRunCheckpoints } from './run-checkpoint-routes.js'
import {
  MAX_RUNTIME_EVENT_REASON_LENGTH,
  parseRuntimeTaskEventBody,
} from './runtime-event-request.js'

const MAX_ACTIVE_STREAM_RUNS = 16
const MAX_PENDING_APPROVALS = 64
const RUNTIME_EVENT_REGISTRATION_WAIT_MS = 2_000
const RUNTIME_EVENT_REGISTRATION_POLL_MS = 20

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

interface DurableInboxRecoveryStore {
  listRecoverableRuns?: () => Promise<Array<{ sessionId: string; runId: string }>>
  listActiveClaimedRuns?: () => Promise<Array<{ sessionId: string; runId: string }>>
  nextClaimLeaseExpiry?: () => Promise<string | undefined>
}

interface DurableRunLeaseRecoveryStore {
  listActiveRuns?: () => Promise<Array<{ sessionId: string; runId: string }>>
  listRecoverableRuns?: () => Promise<Array<{ sessionId: string; runId: string }>>
  nextLeaseExpiry?: () => Promise<string | undefined>
}

interface DurableRecoveryInfrastructure {
  durableRunLeaseStore?: DurableRunLeaseRecoveryStore
}

export interface RunRouteContext {
  /** Undefined until the composition root publishes the Runner; fail closed. */
  getRunner: () => AgentRunner | undefined
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
  private durableRecoveryTimer: NodeJS.Timeout | undefined
  private stopped = false

  static async create(initialRunner: AgentRunner): Promise<RunRouter> {
    const router = new RunRouter()
    await router.recoverDurableRuns(initialRunner)
    try {
      const recovered = await initialRunner.runCheckpoints?.recoverInterruptedResumes(
        'application restarted before checkpoint continuation completed',
      ) ?? 0
      if (recovered > 0) console.info(`[run-checkpoints] released ${recovered} interrupted resume lease(s)`)
    } catch (error) {
      console.error(`[run-checkpoints] startup lease recovery failed: ${(error as Error).message}`)
    }
    try {
      const reconciled = await initialRunner.runCheckpoints?.reconcileCompletedRuns(
        'startup reconciled checkpoint with successful execution log',
      ) ?? 0
      if (reconciled > 0) console.info(`[run-checkpoints] sealed ${reconciled} checkpoint(s) from successful execution logs`)
    } catch (error) {
      console.error(`[run-checkpoints] startup completion reconciliation failed: ${(error as Error).message}`)
    }
    return router
  }

  private async recoverDurableRuns(initialRunner: AgentRunner, includeEventRuns = true): Promise<void> {
    const durableEventStore = initialRunner.infra?.durableEventStore
    const durableInboxStore = initialRunner.infra?.durableInboxStore as unknown as DurableInboxRecoveryStore | undefined
    const durableRunLeaseStore = (initialRunner.infra as unknown as DurableRecoveryInfrastructure | undefined)
      ?.durableRunLeaseStore
    if (((includeEventRuns && durableEventStore?.listRuns)
      || durableInboxStore?.listRecoverableRuns
      || durableRunLeaseStore?.listRecoverableRuns) && initialRunner.recoverDurableRun) {
      try {
        const activeClaimedRuns = new Set([
          ...(await durableInboxStore?.listActiveClaimedRuns?.() ?? []),
          ...(await durableRunLeaseStore?.listActiveRuns?.() ?? []),
        ].map((run) => `${run.sessionId}\0${run.runId}`))
        const discoveredRuns = [
          ...(includeEventRuns
            ? (await durableEventStore?.listRuns?.() ?? []).filter(
                (run) => !activeClaimedRuns.has(`${run.sessionId}\0${run.runId}`),
              )
            : []),
          ...(await durableInboxStore?.listRecoverableRuns?.() ?? []),
          ...(await durableRunLeaseStore?.listRecoverableRuns?.() ?? []),
        ]
        const durableRuns = [...new Map(discoveredRuns.map((run) => (
          [`${run.sessionId}\0${run.runId}`, run] as const
        ))).values()].sort((left, right) => (
          left.sessionId.localeCompare(right.sessionId) || left.runId.localeCompare(right.runId)
        ))
        for (const durableRun of durableRuns) {
          try {
            const recovery = await initialRunner.recoverDurableRun(
              asSessionId(durableRun.sessionId),
              durableRun.runId,
            )
            if (recovery.actions.length > 0) {
              console.info(`[durable-harness] recovered ${durableRun.runId}: ${recovery.actions.map((action) => action.kind).join(', ')}`)
            }
          } catch (error) {
            // A corrupt or concurrently-owned run must remain visible for a
            // later operator decision; startup of the Local API still proceeds.
            console.error(`[durable-harness] recovery failed for ${durableRun.runId}: ${(error as Error).message}`)
          }
        }
      } catch (error) {
        console.error(`[durable-harness] run recovery discovery failed: ${(error as Error).message}`)
      }
    }
    try {
      await this.scheduleDurableRecovery(initialRunner)
    } catch (error) {
      console.error(`[durable-harness] recovery wake-up scheduling failed: ${(error as Error).message}`)
    }
  }

  private async scheduleDurableRecovery(initialRunner: AgentRunner): Promise<void> {
    if (this.stopped) return
    if (this.durableRecoveryTimer) clearTimeout(this.durableRecoveryTimer)
    this.durableRecoveryTimer = undefined
    // Optional while an older Runner declaration is being rebuilt.
    const durableInboxStore = initialRunner.infra?.durableInboxStore as unknown as DurableInboxRecoveryStore | undefined
    const durableRunLeaseStore = (initialRunner.infra as unknown as DurableRecoveryInfrastructure | undefined)
      ?.durableRunLeaseStore
    const expiries = [
      await durableInboxStore?.nextClaimLeaseExpiry?.(),
      await durableRunLeaseStore?.nextLeaseExpiry?.(),
    ].filter((value): value is string => Boolean(value)).sort()
    const expiresAt = expiries[0]
    if (!expiresAt || this.stopped) return
    const delayMs = Math.max(0, Date.parse(expiresAt) - Date.now())
    this.durableRecoveryTimer = setTimeout(() => {
      this.durableRecoveryTimer = undefined
      void this.recoverDurableRuns(initialRunner, false)
    }, delayMs)
    this.durableRecoveryTimer.unref?.()
  }

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

    if (await routeRunCheckpoints(request, context, {
      registerActive: (runId, runner, controller) => {
        if (this.activeStreams.size >= MAX_ACTIVE_STREAM_RUNS || this.activeStreams.has(runId)) return false
        this.activeStreams.set(runId, { runner, controller })
        return true
      },
      releaseActive: (runId, runner, controller) => {
        const active = this.activeStreams.get(runId)
        if (active?.runner === runner && active.controller === controller) this.activeStreams.delete(runId)
      },
      isRunActive: (runId) => this.activeStreams.has(runId),
      createApprovalBroker: (publish, signal) => this.buildApprovalBroker(publish, signal),
    })) return true

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
      const body = await readJson(req)
      const effectiveBody = await withPersistedSessionPermissionMode(context.sessionIndex, body)
      const requestKey = parseRequestKey(body.requestKey)
      const sessionId = body.sessionId ? asSessionId(String(body.sessionId)) : undefined
      const runId = (sessionId ? conversationTurnRunId(sessionId, requestKey) : undefined) ?? randomUUID()
      const existingActive = this.activeStreams.get(runId)
      if (!existingActive && this.activeStreams.size >= MAX_ACTIVE_STREAM_RUNS) {
        json(res, 429, { error: 'too many active agent runs' })
        return true
      }
      const controller = new AbortController()
      const runner = existingActive?.runner ?? resolveRunner(context.getRunner)
      const active: ActiveStreamRun = existingActive ?? { controller, runner }
      const ownsActiveRun = !existingActive
      if (ownsActiveRun) this.activeStreams.set(runId, active)
      const stopHeartbeat = openSse(res)
      // Let the renderer show the run immediately while workspace and
      // attachment preparation continues asynchronously below.
      writeSse(res, 'start', { ok: true, runId })
      try {
        const ownership = await resolveRunSessionOwnership(context.sessionIndex, context.projectIndex, effectiveBody)
        // Ownership first, then the directory: see `resolveOwnedRunWorkspace`.
        const cwd = await resolveOwnedRunWorkspace(
          context,
          effectiveBody,
          ownership,
          context.getConfig(),
          context.workplaceDir,
        )
        const workspaceContext = resolveRunWorkspaceContext(cwd, ownership, context.workplaceDir)
        const attachmentOptions = {
          managedCache: context.attachmentCache,
          workplaceDir: context.workplaceDir,
          workspaceDir: cwd,
          projectId: ownership.projectId,
        }
        const attachmentRefs = await ensureManagedAttachmentRefs(
          parseAttachments(effectiveBody.attachments),
          context.attachmentCache,
        )
        const attachments = await prepareRunAttachments(attachmentRefs, attachmentOptions)
        const inspectAttachmentTool = createInspectAttachmentTool(attachments)
        const restoreCheckpointResources = createCheckpointResourceResolver(attachmentOptions)
        // Publish the run identity before Runner can emit step/tool deltas.
        // A synchronous portion of a runner may produce events immediately;
        // the renderer must be able to address the run for interruption from
        // the first streamed frame onward.
        const runPromise = runner.runStream(
          {
            runId,
            text: String(body.text ?? ''),
            sessionId,
            origin: 'app',
            cwd,
            reasoning: resolveReasoning(body, context.getConfig()),
            attachments,
            additionalTools: inspectAttachmentTool ? [inspectAttachmentTool] : undefined,
            restoreCheckpointResources,
            requestKey,
            workspaceContext,
            signal: controller.signal,
            onToolEvent: (event) => writeSse(res, event.type, event),
            onAssistantReplace: (text) => writeSse(res, 'replace', { text }),
            ...resolveRunPolicy(
              effectiveBody,
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
        const publishedResult = (result.durableHarnessMode ?? runner.durableHarnessMode) === 'next'
          ? await prepareAuthoritativeRunnerResult(runner, result)
          : result
        if (publishedResult.runtimeStatus) {
          // Remove a provisional stream when the durable publication gate
          // cannot prove a settled final reply.
          writeSse(res, 'replace', { text: '' })
        }
        if (ownsActiveRun) {
          await finishRunResources(context, runner, publishedResult, effectiveBody, ownership, cwd, workspaceContext)
        }
        writeSse(res, 'result', publishedResult)
      } catch (error) {
        writeSse(res, 'error', { error: (error as Error).message })
      } finally {
        stopHeartbeat()
        if (ownsActiveRun && this.activeStreams.get(runId) === active) this.activeStreams.delete(runId)
        res.end()
      }
      return true
    }

    if (method === 'POST' && path === LOCAL_APP_API_ROUTES.run) {
      const body = await readJson(req)
      const effectiveBody = await withPersistedSessionPermissionMode(context.sessionIndex, body)
      const runner = resolveRunner(context.getRunner)
      const ownership = await resolveRunSessionOwnership(context.sessionIndex, context.projectIndex, effectiveBody)
      // Ownership first: a project-bound session's directory is its project's, so
      // the request's workspace cannot move it.
      const cwd = await resolveOwnedRunWorkspace(
        context,
        effectiveBody,
        ownership,
        context.getConfig(),
        context.workplaceDir,
      )
      const workspaceContext = resolveRunWorkspaceContext(cwd, ownership, context.workplaceDir)
      const attachmentOptions = {
        managedCache: context.attachmentCache,
        workplaceDir: context.workplaceDir,
        workspaceDir: cwd,
        projectId: ownership.projectId,
      }
      const attachmentRefs = await ensureManagedAttachmentRefs(
        parseAttachments(effectiveBody.attachments),
        context.attachmentCache,
      )
      const attachments = await prepareRunAttachments(attachmentRefs, attachmentOptions)
      const inspectAttachmentTool = createInspectAttachmentTool(attachments)
      const result = await runner.run({
        text: String(body.text ?? ''),
        sessionId: body.sessionId ? asSessionId(String(body.sessionId)) : undefined,
        origin: 'app',
        cwd,
        reasoning: resolveReasoning(body, context.getConfig()),
        attachments,
        additionalTools: inspectAttachmentTool ? [inspectAttachmentTool] : undefined,
        restoreCheckpointResources: createCheckpointResourceResolver(attachmentOptions),
        requestKey: parseRequestKey(body.requestKey),
        workspaceContext,
        ...resolveRunPolicy(effectiveBody, context.getConfig(), undefined, {
          containerRoot: context.dataDir ?? context.workplaceDir,
          cwd,
        }),
      })
      const publishedResult = (result.durableHarnessMode ?? runner.durableHarnessMode) === 'next'
        && !runner.isResultAuthoritativePrepared?.(result)
        ? await prepareAuthoritativeRunnerResult(runner, result)
        : result
      await finishRunResources(context, runner, publishedResult, effectiveBody, ownership, cwd, workspaceContext)
      // A run the runtime recorded as failed must not answer 200: callers (the
      // UI, automation, the harness-path comparison) otherwise see a successful
      // response with no reply and cannot tell a failure from an empty turn.
      // Measured: eleven runs recorded as status=error in the durable log were
      // all reported as HTTP 200 without any reply field.
      json(res, publishedResult.status === 'error' ? 500 : 200, publishedResult)
      return true
    }

    return false
  }

  stop(): void {
    this.stopped = true
    if (this.durableRecoveryTimer) clearTimeout(this.durableRecoveryTimer)
    this.durableRecoveryTimer = undefined
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseRequestKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('conversation requestKey must be a string')
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length > 256) throw new Error('conversation requestKey exceeds 256 characters')
  return normalized
}
