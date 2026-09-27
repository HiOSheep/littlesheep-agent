// The local SSE response is only an observer. A dropped observer does not prove
// the run failed; read the authoritative execution log before erasing its preview.
import { replayCompletedRun, type RunResult } from '../api/run'

const REPLAY_INTERVAL_MS = 1_500
const REPLAY_DEADLINE_MS = 10 * 60_000

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
