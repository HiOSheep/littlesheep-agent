// Agent run, streaming, approval and run-owned resource lifecycle routes.

import { randomUUID } from 'node:crypto'
import { captureShellAuthorizationScope } from '../shell-authorization-scope.js'
import { ShellRepeatAuthorizationStore } from '../shell-repeat-authorization-store.js'
import { createHostMemoryAccessGrant } from '../memory-access-host.js'
import type { Config } from '@littlesheep/config'
import { conversationTurnRunId, publishRunnerResult, type AgentRunner } from '@littlesheep/runner'
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
import { DeferredRunRecovery } from '../run-recovery.js'
import { resolveRunPolicy, type RunApprovalBroker } from '../run-policy.js'
import type { RunApprovalRequest } from '../../shared/approval-contract.js'
import type { ShellApprovalResult } from '@littlesheep/tools'
import type { SessionIndex } from '../session-index.js'
import type { WorkspaceArtifactIndex } from '../workspace-artifact-index.js'
import { json, openSse, readJson, resolveRunner, writeSse, type LocalAppApiRequest } from './http.js'
import { resolveReasoning } from './runtime-routes.js'
import {
  finishRunResources,
  resolveOwnedRunWorkspace,
  prepareRunWorkspace,
  resolveRunModelRef,
  resolveRunSessionOwnership,
  resolveRunWorkspaceContext,
  bindRunSessionPolicy,
  withPersistedSessionPermissionMode,
} from './run-support.js'
import { routeRunCheckpoints } from './run-checkpoint-routes.js'
import { writeToolEventSse } from './run-tool-event-projection.js'
import {
  MAX_RUNTIME_EVENT_REASON_LENGTH,
  parseRuntimeTaskEventBody,
} from './runtime-event-request.js'

const MAX_ACTIVE_STREAM_RUNS = 16
const MAX_INLINE_RUN_RESULT_BYTES = 64 * 1024
const MAX_PENDING_APPROVALS = 64
const RUNTIME_EVENT_REGISTRATION_WAIT_MS = 2_000
const RUNTIME_EVENT_REGISTRATION_POLL_MS = 20

interface PendingApproval {
  resolve: (result: ShellApprovalResult) => void
  cleanup: () => void
  rememberShellCommand?: () => boolean
}

interface ActiveStreamRun {
  controller: AbortController
  runner: AgentRunner
}

type ApprovalRequestPayload = RunApprovalRequest & { id: string; source: 'agent' }

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
  private recovery: DeferredRunRecovery | undefined

  constructor(private readonly shellRepeatAuthorizations = new ShellRepeatAuthorizationStore()) {}

  /**
   * Build the router without waiting for recovery.
   *
   * `server.setRunner` is what publishes execution readiness, so anything awaited
   * here delays the moment the user may send a message. Recovery of previous runs
   * is therefore started, not awaited; the routes that genuinely need it await
   * `this.recovery.done()` themselves (see `route`).
   */
  static async create(
    initialRunner: AgentRunner,
    shellRepeatAuthorizations = new ShellRepeatAuthorizationStore(),
  ): Promise<RunRouter> {
    const router = new RunRouter(shellRepeatAuthorizations)
    // The modern lease and inbox stores identify work that may need recovery
    // now. Scanning every historical event partition can be very expensive on
    // a long-lived data root, so it must not gate fresh interaction. Keep the
    // event-only scan as a background compatibility pass for older runs that
    // predate the lease store.
    router.recovery = DeferredRunRecovery.start(initialRunner, {
      // The router's own active-stream registry is the live-run answer: a resume
      // the user started after this Runner was published is in it, and the
      // deferred pass must not release that resume's lease as if the process had
      // died. On a real restart the registry is empty and every stale lease is
      // released exactly as before.
      isRunActive: (runId) => router.activeStreams.has(runId),
    })
    return router
  }

  /** Exposed so the checkpoint routes can gate on the same recovery pass. */
  waitForRecovery(sessionId?: string): Promise<void> {
    return this.recovery?.waitIfNeeded(sessionId) ?? Promise.resolve()
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
      if (body.rememberShellCommand !== undefined && typeof body.rememberShellCommand !== 'boolean') {
        json(res, 400, { error: 'rememberShellCommand must be a boolean' })
        return true
      }
      const approved = body.approved === true
      if (body.rememberShellCommand === true) {
        let remembered = false
        try { remembered = approved && pending.rememberShellCommand?.() === true }
        catch { remembered = false }
        if (!remembered) {
          this.pendingApprovals.delete(approvalId)
          pending.cleanup()
          pending.resolve(false)
          json(res, 409, { error: 'Shell repeat authorization is unavailable or no longer eligible' })
          return true
        }
      }
      this.pendingApprovals.delete(approvalId)
      pending.cleanup()
      pending.resolve(approved && body.rememberShellCommand === true
        ? { approved: true, rememberShellCommand: true }
        : approved)
      json(res, 200, { ok: true })
      return true
    }

    // Every checkpoint route reads checkpoint or disposition state that startup
    // recovery may still be rewriting (released resume leases, sealed completed
    // runs), so listing, inspecting, abandoning and resuming all observe the
    // same recovery pass before they answer. The UI's recovery banner is one of
    // those reads: it must not miss a checkpoint that recovery is about to
    // release.
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
      consumeShellRepeatAuthorization: (description) => this.shellRepeatAuthorizations.consume(description),
      rememberShellRepeatAuthorization: (description) => this.shellRepeatAuthorizations.remember(description),
      waitForRecovery: () => this.waitForRecovery(),
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
      // This is the run path the send control uses. A brand-new conversation has
      // no session id and is admitted immediately; a run that names a session may
      // be the next turn of a conversation whose previous run is still being
      // recovered, so it observes recovery before the Runner sees it. The wait is
      // on a pass that is already running, so it costs nothing once it settled.
      await this.waitForRecovery(sessionId)
      // A first Renderer turn may already carry a stable request key even though
      // Main has not persisted its Session yet. Reserve that Session identity
      // before publishing the Run ID so Runner sees the same
      // sessionId + requestKey pair that produced the streamed identity.
      const preallocatedSessionId = !sessionId && requestKey ? asSessionId(randomUUID()) : undefined
      const runSessionId = sessionId ?? preallocatedSessionId
      const runId = (runSessionId ? conversationTurnRunId(runSessionId, requestKey) : undefined) ?? randomUUID()
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
        const selectedWorkspace = await resolveOwnedRunWorkspace(
          context,
          effectiveBody,
          ownership,
          context.getConfig(),
          context.workplaceDir,
        )
        const cwd = await prepareRunWorkspace(selectedWorkspace, effectiveBody)
        const workspaceContext = resolveRunWorkspaceContext(cwd, ownership, context.workplaceDir)
        const boundSession = await bindRunSessionPolicy(
          context.sessionIndex,
          effectiveBody,
          ownership,
          cwd,
          sessionId,
          preallocatedSessionId,
        )
        const boundRunSessionId = boundSession.sessionId
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
            memoryAccessGrant: await createHostMemoryAccessGrant({
              dataDir: context.dataDir ?? context.workplaceDir,
              runId,
              sessionId: String(boundRunSessionId),
              workspace: cwd,
              ownership,
              sessionIndex: context.sessionIndex,
              projectIndex: context.projectIndex,
            }),
            text: String(body.text ?? ''),
            sessionId: boundRunSessionId,
            origin: 'app',
            model: resolveRunModelRef(body, context.getConfig()),
            cwd,
            reasoning: resolveReasoning(body, context.getConfig()),
            attachments,
            additionalTools: inspectAttachmentTool ? [inspectAttachmentTool] : undefined,
            restoreCheckpointResources,
            requestKey,
            workspaceContext,
            signal: controller.signal,
            onToolEvent: (event) => writeToolEventSse(res, event),
            onAssistantReplace: (text) => writeSse(res, 'replace', { text }),
            ...resolveRunPolicy(
              effectiveBody,
              context.getConfig(),
              this.buildApprovalBroker(
                (approval) => writeSse(res, 'approval_request', approval),
                controller.signal,
              ),
              {
                shellScope: await captureShellAuthorizationScope({ runId, sessionId: String(boundRunSessionId),
                  projectId: ownership.projectId, signal: controller.signal, sessionIndex: context.sessionIndex, projectIndex: context.projectIndex }),
                containerRoot: context.dataDir ?? context.workplaceDir,
                dataRoot: context.dataDir,
                workspaceRoot: cwd,
                protectedRoots: runner.protectedWriteRoots,
                cwd,
                fullAccessConfirmed: effectiveBody.permissionPreset === 'full-access',
                shellRepeatAuthorization: {
                  consume: (description) => this.shellRepeatAuthorizations.consume(description),
                  remember: (description) => this.shellRepeatAuthorizations.remember(description),
                },
              },
            ),
          },
          (delta) => writeSse(res, 'delta', { delta }),
        )
        const result = await runPromise
        if (result.runId !== runId) throw new Error(`runner returned an unexpected run id: ${result.runId}`)
        const publishedResult = await publishRunnerResult(runner, result)
        if (publishedResult.runtimeStatus) {
          // Remove a provisional stream when the durable publication gate
          // cannot prove a settled final reply.
          writeSse(res, 'replace', { text: '' })
        }
        if (ownsActiveRun) {
          await finishRunResources(context, runner, publishedResult, boundSession.body, ownership, cwd, workspaceContext)
        }
        // A large settlement can exceed the bounded SSE socket buffer even though
        // the run finished normally. Send an id and let the observer read the
        // already persisted authoritative log instead of destroying its socket.
        const serializedResult = JSON.stringify(publishedResult)
        if (Buffer.byteLength(serializedResult, 'utf8') > MAX_INLINE_RUN_RESULT_BYTES) {
          writeSse(res, 'result_ref', { runId })
        } else {
          writeSse(res, 'result', publishedResult)
        }
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
      // Same rule as the streaming path: a named session may carry a previous run
      // that recovery is still settling, so the non-streaming entry point waits
      // too. A session-less request is a brand-new conversation and does not.
      await this.waitForRecovery(effectiveBody.sessionId === undefined ? undefined : String(effectiveBody.sessionId))
      const runner = resolveRunner(context.getRunner)
      const ownership = await resolveRunSessionOwnership(context.sessionIndex, context.projectIndex, effectiveBody)
      // Ownership first: a project-bound session's directory is its project's, so
      // the request's workspace cannot move it.
      const selectedWorkspace = await resolveOwnedRunWorkspace(
        context,
        effectiveBody,
        ownership,
        context.getConfig(),
        context.workplaceDir,
      )
      const cwd = await prepareRunWorkspace(selectedWorkspace, effectiveBody)
      const workspaceContext = resolveRunWorkspaceContext(cwd, ownership, context.workplaceDir)
      const priorSessionId = effectiveBody.sessionId ? asSessionId(String(effectiveBody.sessionId)) : undefined
      const boundSession = await bindRunSessionPolicy(context.sessionIndex, effectiveBody, ownership, cwd, priorSessionId)
      const runSessionId = boundSession.sessionId
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
      const hostRunId = priorSessionId
        ? conversationTurnRunId(runSessionId, parseRequestKey(body.requestKey)) ?? randomUUID()
        : randomUUID()
      const result = await runner.run({
        runId: hostRunId,
        text: String(body.text ?? ''),
        memoryAccessGrant: await createHostMemoryAccessGrant({ dataDir: context.dataDir ?? context.workplaceDir,
          runId: hostRunId, sessionId: String(runSessionId),
          workspace: cwd, ownership, sessionIndex: context.sessionIndex, projectIndex: context.projectIndex }),
        sessionId: runSessionId,
        origin: 'app',
        model: resolveRunModelRef(body, context.getConfig()),
        cwd,
        reasoning: resolveReasoning(body, context.getConfig()),
        attachments,
        additionalTools: inspectAttachmentTool ? [inspectAttachmentTool] : undefined,
        restoreCheckpointResources: createCheckpointResourceResolver(attachmentOptions),
        requestKey: parseRequestKey(body.requestKey),
        workspaceContext,
        ...resolveRunPolicy(effectiveBody, context.getConfig(), undefined, {
          shellScope: await captureShellAuthorizationScope({ runId: hostRunId, sessionId: String(runSessionId),
            projectId: ownership.projectId, sessionIndex: context.sessionIndex, projectIndex: context.projectIndex }),
          containerRoot: context.dataDir ?? context.workplaceDir,
          dataRoot: context.dataDir,
          workspaceRoot: cwd,
          protectedRoots: runner.protectedWriteRoots,
          cwd,
          fullAccessConfirmed: effectiveBody.permissionPreset === 'full-access',
          shellRepeatAuthorization: {
            consume: (description) => this.shellRepeatAuthorizations.consume(description),
            remember: (description) => this.shellRepeatAuthorizations.remember(description),
          },
        }),
      })
      const publishedResult = await publishRunnerResult(runner, result)
      await finishRunResources(context, runner, publishedResult, boundSession.body, ownership, cwd, workspaceContext)
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
    this.recovery?.stop()
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
    return async ({ action, detail, permissionMode, permissionPreset, boundary, requiresExplicitUserApproval,
      rememberShellCommandAvailable, shellBatch }) => {
      const id = randomUUID()
      return new Promise<ShellApprovalResult>((resolveApproval) => {
        let settled = false
        let timer: NodeJS.Timeout | undefined
        let onAbort: (() => void) | undefined
        const cleanup = () => {
          if (timer) clearTimeout(timer)
          if (onAbort) signal?.removeEventListener('abort', onAbort)
        }
        const settle = (result: ShellApprovalResult) => {
          if (settled) return
          settled = true
          cleanup()
          this.pendingApprovals.delete(id)
          resolveApproval(result)
        }
        onAbort = () => settle(false)
        timer = setTimeout(() => settle(false), 120_000)
        while (this.pendingApprovals.size >= MAX_PENDING_APPROVALS) {
          const oldest = this.pendingApprovals.values().next().value as PendingApproval | undefined
          if (!oldest) break
          oldest.cleanup()
          oldest.resolve(false)
        }
        const rememberable = rememberShellCommandAvailable === true
          && shellBatch?.scope === 'once' && shellBatch.commands.length === 1
          && this.shellRepeatAuthorizations.canRemember(shellBatch.commands[0]!)
          ? shellBatch.commands[0]
          : undefined
        this.pendingApprovals.set(id, {
          resolve: settle,
          cleanup,
          ...(rememberable
            ? { rememberShellCommand: () => !settled && !signal?.aborted }
            : {}),
        })
        if (signal?.aborted) {
          settle(false)
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
          requestApproval({
            id,
            action,
            detail,
            permissionMode,
            ...(permissionPreset ? { permissionPreset } : {}),
            boundary,
            ...(requiresExplicitUserApproval ? { requiresExplicitUserApproval: true } : {}),
            ...(rememberable ? { rememberShellCommandAvailable: true } : {}),
            source: 'agent',
            ...(shellBatch ? { shellBatch } : {}),
          })
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
