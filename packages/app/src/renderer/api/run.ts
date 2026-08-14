// Agent run and SSE stream client.

import type { RuntimeReasoning } from '../../shared/model-capabilities'
import type { SessionScope } from '../../shared/session-scope'
import type { AttachmentRef } from '../../shared/attachment-contracts'
import {
  LOCAL_APP_API_PREFIXES,
  LOCAL_APP_API_ROUTES,
  localAppApiItemPath,
} from '../../shared/local-app-api-routes'
import type {
  ContextSnapshot,
  ConversationContinuationEvidence,
  ModelRequestSnapshot,
  ReplyProvenance,
  RuntimeControlSnapshot,
  RuntimeEventIngressOutcome,
  TaskBook,
  ToolStreamEvent,
  VerificationRecord,
} from '@littlesheep/types'
import type { AgentProfileId } from '@littlesheep/prompt'
import type { PermissionModeId } from '../../shared/permission-modes'
import type {
  LocalAppRuntimeControlEventResponse,
  LocalAppRuntimeControlEventType,
  LocalAppRuntimeTaskEventRequest,
  LocalAppRuntimeTaskEventResponse,
} from '../../shared/runtime-event-contracts'
import { localApiResponseError, localApiStatusError, localApiUrl, parseSseFrame } from './common'

export interface RunResult {
  runId: string
  sessionId: string
  status: 'ok' | 'error' | 'aborted'
  reply: string
  replyProvenance?: ReplyProvenance
  error?: string
  durationMs: number
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens?: number
    source: 'provider'
  }
  contextSnapshots?: ContextSnapshot[]
  modelRequests?: ModelRequestSnapshot[]
  trace?: { name: string; ok: boolean }[]
  messages?: { role: string; content: unknown[] }[]
  taskBook?: TaskBook
  verificationHistory?: VerificationRecord[]
  runtimeControl?: RuntimeControlSnapshot
  conversationContinuation?: ConversationContinuationEvidence
  runCheckpointId?: string
  taskExecution?: {
    goal: string
    complexity: string
    status: string
    startedAt: string
    endedAt?: string
    summary?: string
    steps: Array<{
      stepId: string
      title?: string
      description: string
      status: string
      startedAt: string
      endedAt?: string
      output?: string
      error?: string
      failureKind?: 'tool_error' | 'permission_denied' | 'not_found' | 'model_error' | 'verification_gap' | 'aborted' | 'unknown'
      attempt?: number
      toolCallIds: string[]
    }>
    replanHistory?: Array<{
      attempt: number
      requestedAt: string
      targetStepIds: string[]
      reason: string
      feedback: string
      preservedStepIds: string[]
      revisedStepIds?: string[]
      decidedAt?: string
      resumedAt?: string
    }>
  }
  clarificationRequest?: {
    id: string
    kind: 'missing_information' | 'ambiguous_request' | 'recovery_decision'
    sourceStage: 'classify' | 'decide' | 'execute' | 'recover' | 'verify'
    createdAt: string
    originalRequest: string
    blockingReason: string
    missingInfo?: string[]
    questions: Array<{
      id: string
      field: string
      prompt: string
      required: boolean
      options?: string[]
      defaultValue?: string
    }>
    prompt?: string
  }
  clarificationResponse?: {
    requestId: string
    answer: string
    answeredAt: string
  }
}

export async function runAgent(
  text: string,
  sessionId?: string,
  permissionMode?: PermissionModeId,
  profile?: AgentProfileId,
): Promise<RunResult> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.run), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId, permissionMode, profile }),
  })
  if (!res.ok) throw localApiStatusError(res.status)
  return res.json() as Promise<RunResult>
}

export interface RunStreamHandlers {
  signal?: AbortSignal
  onStart?: (event: RunStreamStart) => void
  onDelta: (delta: string) => void
  onReplace?: (text: string) => void
  onApprovalRequest?: (request: ApprovalRequest) => boolean | Promise<boolean>
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
  id: string
  action: string
  detail?: unknown
  permissionMode: PermissionModeId
  /** Boundary calculated by the Main process for Agent requests. */
  boundary?: 'inside' | 'outside' | 'unknown'
  source?: 'agent' | 'workspace'
}

export interface RunOptions {
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
  permissionMode: PermissionModeId | undefined,
  handlers: RunStreamHandlers,
  options: RunOptions = {},
): Promise<RunResult> {
  const res = await fetch(localApiUrl(LOCAL_APP_API_ROUTES.runStream), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId, permissionMode, ...options }),
    signal: handlers.signal,
  })
  return consumeRunStream(res, handlers)
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
  let activeRunId = ''

  while (true) {
    const { value, done } = await reader.read()
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
        const d = event.data as { callId?: string; name?: string; stepId?: string; input?: unknown; ok?: boolean; output?: string; error?: string }
        handlers.onToolEvent?.({
          type: event.name,
          callId: String(d.callId ?? ''),
          name: String(d.name ?? ''),
          stepId: d.stepId,
          input: d.input,
          ok: d.ok,
          output: d.output,
          error: d.error,
        })
      } else if (
        event.name === 'task_book'
        || event.name === 'step_start'
        || event.name === 'step_done'
        || event.name === 'step_failed'
        || event.name === 'step_skipped'
        || event.name === 'verification_start'
        || event.name === 'verification'
        || event.name === 'final_delta'
      ) {
        handlers.onToolEvent?.(event.data as ToolStreamEvent)
      } else if (event.name === 'approval_request') {
        const d = event.data as ApprovalRequest
        const approved = await handlers.onApprovalRequest?.(d) ?? false
        await respondApproval(String(d.id), approved)
      } else if (event.name === 'result') {
        finalResult = event.data as RunResult
      } else if (event.name === 'error') {
        throw new RunStreamServerError(
          String((event.data as { error?: string }).error ?? 'stream failed'),
          activeRunId || undefined,
        )
      }
    }
    if (done) break
  }

  if (!finalResult) throw new Error('Local app API stream ended without result')
  if (!activeRunId) throw new Error('Local app API stream ended without start metadata')
  if (finalResult.runId !== activeRunId) throw new Error('Local app API stream result run id does not match start metadata')
  return finalResult
}

export async function sendRuntimeControlEvent(
  runId: string,
  type: LocalAppRuntimeControlEventType,
  reason?: string,
): Promise<RuntimeEventIngressOutcome> {
  const path = localAppApiItemPath(LOCAL_APP_API_PREFIXES.runs, runId, '/events')
  const res = await fetch(localApiUrl(path), {
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
  const res = await fetch(localApiUrl(path), {
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

async function respondApproval(id: string, approved: boolean): Promise<void> {
  const res = await fetch(localApiUrl(localAppApiItemPath(LOCAL_APP_API_PREFIXES.approvals, id)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved }),
  })
  if (!res.ok) throw localApiStatusError(res.status)
}
