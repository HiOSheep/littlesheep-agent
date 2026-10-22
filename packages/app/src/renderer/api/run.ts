// Agent run and SSE stream client.

import type { RuntimeReasoning } from '../../shared/model-capabilities'
import type { ApprovalReply } from '../approval-grants'
import type { SessionScope } from '../../shared/session-scope'
import type { AttachmentRef } from '../../shared/attachment-contracts'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../../shared/local-app-api-routes'
import type {
  RuntimeEventIngressOutcome,
  ToolStreamEvent,
} from '@littlesheep/types'
import type { RunnerResult } from '@littlesheep/runner'
import type { AgentProfileId } from '@littlesheep/prompt'
import type { PermissionPresetId } from '@littlesheep/types'
import { isPermissionSelectionPreset, type PermissionModeId, type PermissionSelectionId } from '../../shared/permission-modes'
import type {
  LocalAppRuntimeControlEventResponse,
  LocalAppRuntimeControlEventType,
  LocalAppRuntimeTaskEventRequest,
  LocalAppRuntimeTaskEventResponse,
} from '../../shared/runtime-event-contracts'
import { localApiFetch, localApiResponseError, localApiStatusError, parseSseFrame } from './common'

/**
 * The renderer's view of a RunnerResult. Derived from the authoritative
 * contract instead of re-declaring every field, so new AgentResult fields
 * remain visible; only the HTTP-visible narrowing is declared here.
 */
export type RunResult = Omit<RunnerResult, 'status' | 'reply' | 'sessionId' | 'messages' | 'trace'> & {
  sessionId: string
  status: 'ok' | 'error' | 'aborted'
  reply: string
  /** Optional at the HTTP boundary; the Runner always sends them on success. */
  messages?: RunnerResult['messages']
  trace?: RunnerResult['trace']
}
export async function runAgent(
  text: string,
  sessionId?: string,
  permissionMode?: PermissionSelectionId,
  profile?: AgentProfileId,
): Promise<RunResult> {
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.run, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      sessionId,
      ...(isPermissionSelectionPreset(permissionMode)
        ? { permissionPreset: permissionMode }
        : { permissionMode }),
      profile,
    }),
  })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<RunResult>
}

export interface RunStreamHandlers {
  signal?: AbortSignal
  onStart?: (event: RunStreamStart) => void
  onDelta: (delta: string) => void
  onReplace?: (text: string) => void
  onApprovalRequest?: (request: ApprovalRequest) => ApprovalReply | Promise<ApprovalReply>
  onToolEvent?: (evt: ToolStreamEvent) => void
}

export interface RunStreamStart {
  runId: string
}

/** A definitive HTTP/SSE rejection; callers may keep draft content but start a new turn after remediation. */
export class RunStreamServerError extends Error {
  readonly runId?: string

  constructor(message: string, runId?: string) {
    super(message)
    this.name = 'RunStreamServerError'
    this.runId = runId
  }
}

export interface ApprovalRequest {
  shellBatch?: import('@littlesheep/types').ShellApprovalBatch
  id: string
  action: string
  detail?: unknown
  permissionMode: PermissionModeId
  permissionPreset?: PermissionPresetId
  /** Main requires an explicit decision even when the session is full-access. */
  requiresExplicitUserApproval?: boolean
  /** Main-computed eligibility for the single exact-command repeat option. */
  rememberShellCommandAvailable?: boolean
  /** Boundary calculated by the Main process for Agent requests. */
  boundary?: 'inside' | 'outside' | 'unknown'
  source?: 'agent' | 'workspace'
}

export interface RunOptions {
  model?: string
  workspace?: string
  sessionScope?: SessionScope
  projectId?: string
  reasoning?: RuntimeReasoning
  profile?: AgentProfileId
  attachments?: AttachmentRef[]
  requestKey?: string
}

export async function runAgentStream(
  text: string,
  sessionId: string | undefined,
  permissionMode: PermissionSelectionId | undefined,
  handlers: RunStreamHandlers,
  options: RunOptions = {},
): Promise<RunResult> {
  const res = await localApiFetch(LOCAL_APP_API_ROUTES.runStream, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      sessionId,
      ...(isPermissionSelectionPreset(permissionMode)
        ? { permissionPreset: permissionMode }
        : { permissionMode }),
      ...options,
    }),
    signal: handlers.signal,
  })
  return consumeRunStream(res, handlers)
}

/** Read the completed authoritative run after a local SSE observer disconnects. */
export async function replayCompletedRun(runId: string, signal?: AbortSignal): Promise<RunResult | null> {
  const response = await localApiFetch(localAppApiItemPath(LOCAL_APP_API_PREFIXES.runs, runId), { signal })
  if (response.status === 404) return null
  if (!response.ok) throw await localApiResponseError(response)
  const log = await response.json() as RunResult
  if (log.runId !== runId || !['ok', 'error', 'aborted'].includes(log.status)) {
    throw new Error('Local App API returned an invalid run replay')
  }
  return log
}

export async function consumeRunStream(
  res: Response,
  handlers: RunStreamHandlers,
): Promise<RunResult> {
  if (!res.ok) {
    const error = await localApiResponseError(res)
    throw new RunStreamServerError(error.message)
  }
  if (!res.body) throw new Error('Local app API stream has no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResult: RunResult | undefined
  let finalResultRef = ''
  let activeRunId = ''
  let approvalError: unknown
  let rejectApprovalFailure: (error: unknown) => void = () => undefined
  const approvalFailure = new Promise<never>((_resolve, reject) => {
    rejectApprovalFailure = reject
  })

  while (true) {
    const { value, done } = await Promise.race([reader.read(), approvalFailure])
    buffer += decoder.decode(value, { stream: !done })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const event = parseSseFrame(frame)
      if (!event) continue
      if (event.name === 'start') {
        const runId = String((event.data as { runId?: string }).runId ?? '').trim()
        if (!runId) throw new Error('Local app API stream started without a run id')
        if (activeRunId && activeRunId !== runId) throw new Error('Local app API stream changed run id')
        if (!activeRunId) {
          activeRunId = runId
          handlers.onStart?.({ runId })
        }
      } else if (event.name === 'delta') {
        handlers.onDelta(String((event.data as { delta?: string }).delta ?? ''))
      } else if (event.name === 'replace') {
        handlers.onReplace?.(String((event.data as { text?: string }).text ?? ''))
      } else if (event.name === 'tool_start' || event.name === 'tool_end') {
        const d = event.data as { callId?: string; name?: string; stepId?: string; input?: unknown; lineProgress?: { additions: number; deletions: number | null }; ok?: boolean; output?: string; error?: string }
        handlers.onToolEvent?.({
          type: event.name,
          callId: String(d.callId ?? ''),
          name: String(d.name ?? ''),
          stepId: d.stepId,
          input: d.input,
          lineProgress: d.lineProgress,
          ok: d.ok,
          output: d.output,
          error: d.error,
        })
      } else if (
        event.name === 'task_book'
        || event.name === 'reasoning'
        || event.name === 'step_start'
        || event.name === 'step_done'
        || event.name === 'step_failed'
        || event.name === 'step_skipped'
        || event.name === 'verification_start'
        || event.name === 'verification'
        || event.name === 'final_delta'
        || event.name === 'model_reasoning'
        || event.name === 'model_activity'
        || event.name === 'runtime_activity'
        || event.name === 'model_text'
        || event.name === 'tool_preparing'
        || event.name === 'system_prompt'
        || event.name === 'capability_snapshot'
        || event.name === 'capability_probe'
      ) {
        handlers.onToolEvent?.(event.data as ToolStreamEvent)
      } else if (event.name === 'approval_request') {
        const d = event.data as ApprovalRequest
        void Promise.resolve(handlers.onApprovalRequest?.(d) ?? false)
          .then((approval) => respondApproval(String(d.id), approval))
          .catch((error: unknown) => {
            // An interrupt can settle the server-side approval while its local
            // prompt is still visible. Keep consuming the authoritative result;
            // the run owner will dismiss that stale prompt in its finally path.
            if (isStaleApprovalResponse(error)) return
            approvalError = error
            rejectApprovalFailure(error)
          })
      } else if (event.name === 'result') {
        finalResult = event.data as RunResult
      } else if (event.name === 'result_ref') {
        finalResultRef = String((event.data as { runId?: string }).runId ?? '')
      } else if (event.name === 'error') {
        throw new RunStreamServerError(
          String((event.data as { error?: string }).error ?? 'stream failed'),
          activeRunId || undefined,
        )
      }
    }
    if (approvalError) throw approvalError
    if (done) break
  }

  if (!finalResult && finalResultRef) {
    if (finalResultRef !== activeRunId) throw new Error('Local app API result reference does not match start metadata')
    finalResult = await replayCompletedRun(finalResultRef)
      ?? undefined
  }
  if (!finalResult) throw new Error('Local app API stream ended without result')
  if (!activeRunId) throw new Error('Local app API stream ended without start metadata')
  if (finalResult.runId !== activeRunId) throw new Error('Local app API stream result run id does not match start metadata')
  if (finalResult.status === 'ok' && finalResult.finalReplySettlement
    && finalResult.finalReplySettlement.status !== 'settled') {
    return {
      ...finalResult,
      status: 'error',
      reply: '',
      error: 'The run ended without a settled final reply.',
    }
  }
  return finalResult
}

export async function sendRuntimeControlEvent(
  runId: string,
  type: LocalAppRuntimeControlEventType,
  reason?: string,
): Promise<RuntimeEventIngressOutcome> {
  const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runs, runId, '/events')
  const res = await localApiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...(reason ? { reason } : {}) }),
  })
  return readRuntimeEventOutcome<LocalAppRuntimeControlEventResponse>(res)
}

/** Submit a bounded task-changing event to an active run. */
export async function sendRuntimeTaskEvent(
  runId: string,
  request: LocalAppRuntimeTaskEventRequest,
): Promise<RuntimeEventIngressOutcome> {
  const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runs, runId, '/events')
  const res = await localApiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  return readRuntimeEventOutcome<LocalAppRuntimeTaskEventResponse>(res)
}


async function readRuntimeEventOutcome<T extends { outcome: RuntimeEventIngressOutcome }>(
  response: Response,
): Promise<RuntimeEventIngressOutcome> {
  const payload = await response.json().catch(() => undefined) as T | undefined
  // A rejected ingress is a valid, explainable runtime result. Main returns it
  // with 409 so callers can distinguish it from malformed requests and
  // transport failures without losing the structured rejection reason.
  if (payload?.outcome) return payload.outcome
  if (!response.ok) throw localApiStatusError(response.status)
  throw new Error('Local app API runtime event response is missing an outcome')
}

async function respondApproval(id: string, approval: ApprovalReply): Promise<void> {
  const body = typeof approval === 'boolean'
    ? { approved: approval }
    : { approved: approval.approved, rememberShellCommand: approval.rememberShellCommand }
  const res = await localApiFetch(localAppApiItemPath(LOCAL_APP_API_PREFIXES.approvals, id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw localApiStatusError(res.status)
}

function isStaleApprovalResponse(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'status' in error
    && (error as { status?: unknown }).status === 404
}
