// The local SSE response is only an observer. A dropped observer does not prove
// the run failed; read the authoritative execution log before erasing its preview.
import { RunStreamServerError } from '../api'
import { replayCompletedRun, type RunResult } from '../api/run'
import { reduceCompletedRunMessages } from './run-result-reducer'
import { updateLastAssistantActivity, upsertLiveReasoning } from './activity-model'
import type { ChatMessage } from './types'

const REPLAY_INTERVAL_MS = 1_500
const REPLAY_DEADLINE_MS = 10 * 60_000

/**
 * What the caller should do after a stream loss was reported to the recovery path.
 *
 * `not-attempted` means the caller keeps the failure it already had; `recovered` means the authoritative
 * result has been applied and the run ended successfully; `failed` carries the error to surface instead.
 */
export type StreamLossRecoveryOutcome =
  | { kind: 'not-attempted' }
  | { kind: 'recovered' }
  | { kind: 'failed'; error: unknown }

export interface StreamLossRecoveryOptions {
  /** The run whose stream dropped; absent means there is nothing to reconcile. */
  runId: string | undefined
  /** The failure that ended the turn; a server-side stream error is a real failure, not a dropped observer. */
  error?: unknown
  signal: AbortSignal
  /** False once the visible conversation moved on: then the recovered result must not be applied. */
  ownsVisibleConversation: () => boolean
  /** The conversation surface the recovery writes to. */
  host: StreamLossRecoveryHost
}

/** The conversation-side pieces a recovered run is applied to. */
export interface StreamLossRecoveryHost {
  setMessages: (updater: (messages: ChatMessage[]) => ChatMessage[]) => void
  setCurrentSession: (sessionId: string) => void
  setWorkspaceArtifactVersion: (updater: (value: number) => number) => void
  pendingConversationTurnRef: { current: unknown }
  deltaBuffer: { flush: () => void }
  refreshSessions: () => unknown
  refreshProjects: () => unknown
}

/**
 * Reconcile a dropped stream against the authoritative execution log.
 *
 * The conversation-side wiring lives here rather than in the per-turn catch block: that block is already
 * the busiest place in the chat controller, and keeping the reconciliation — guards, the activity line the
 * user sees while it runs, and what applying the result means — in one named place is what lets it be read
 * at all.
 */
export async function attemptStreamLossRecovery(
  options: StreamLossRecoveryOptions,
): Promise<StreamLossRecoveryOutcome> {
  const { runId, signal, host } = options
  if (options.error instanceof RunStreamServerError) return { kind: 'not-attempted' }
  if (!runId || signal.aborted || !options.ownsVisibleConversation()) return { kind: 'not-attempted' }
  updateLastAssistantActivity(host.setMessages, (activity) => ({
    ...activity,
    reasoning: upsertLiveReasoning(activity.reasoning ?? [], {
      phaseId: 'runtime:stream-recovery',
      source: 'runtime',
      activityKind: 'runtime_recovery',
      summary: '本地事件流已断开，正在读取本轮运行结果',
      status: 'running',
      startedAt: Date.now(),
    }),
  }))
  try {
    const recovered = await recoverCompletedRunAfterStreamLoss(runId, signal)
    if (!options.ownsVisibleConversation()) return { kind: 'recovered' }
    host.deltaBuffer.flush()
    host.setCurrentSession(recovered.sessionId)
    host.setWorkspaceArtifactVersion((value) => value + 1)
    host.setMessages((messages) => reduceCompletedRunMessages(messages, recovered))
    host.pendingConversationTurnRef.current = null
    void host.refreshSessions()
    void host.refreshProjects()
    return { kind: 'recovered' }
  } catch (error) {
    return { kind: 'failed', error }
  }
}

export async function recoverCompletedRunAfterStreamLoss(
  runId: string,
  signal: AbortSignal,
  replay: (runId: string, signal?: AbortSignal) => Promise<RunResult | null> = replayCompletedRun,
  deadlineMs = REPLAY_DEADLINE_MS,
): Promise<RunResult> {
  const deadline = Date.now() + deadlineMs
  let lastError: unknown
  while (!signal.aborted && Date.now() <= deadline) {
    try {
      const completed = await replay(runId, signal)
      if (completed) return completed
    } catch (error) {
      if (signal.aborted) break
      lastError = error
    }
    await waitForRetry(Math.min(REPLAY_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal)
  }
  if (signal.aborted) {
    const error = new Error('恢复已取消')
    error.name = 'AbortError'
    throw error
  }
  throw new Error(`本地事件流已断开，仍未取得运行结果；可在会话历史中检查本轮状态。${lastError instanceof Error ? ` 最近一次读取失败：${lastError.message}` : ''}`)
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}
