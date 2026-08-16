// Reduces a completed run into the active assistant turn without owning stream lifecycle state.
import type { RunResult } from '../api'
import { buildArtifactsFromToolCalls, buildTraceData, settleLiveReasoning, taskStepToLiveStep } from './activity-model'
import type { ChatMessage } from './types'

export function reduceCompletedRunMessages(
  messages: ChatMessage[],
  result: RunResult,
): ChatMessage[] {
  const last = messages[messages.length - 1]
  if (last?.role !== 'assistant') return messages

  const endedAt = Date.now()
  const traceData = buildTraceData(result)
  const artifacts = buildArtifactsFromToolCalls(traceData.toolCalls)
  const taskSteps = result.taskExecution?.steps?.map((step) => taskStepToLiveStep(step)) ?? []
  const currentActivity = last.activity
  const paused = result.runtimeControl?.state === 'paused'
  const activityStatus = paused
    ? 'paused'
    : result.status === 'ok'
      ? 'done'
      : result.status === 'aborted'
        ? 'aborted'
        : 'failed'
  const next = [...messages]
  next[next.length - 1] = {
    ...last,
    text: last.text || (result.status === 'ok' ? result.reply : ''),
    ...traceData,
    artifacts,
    activityCollapsed: true,
    activity: currentActivity
      ? {
        ...currentActivity,
        status: activityStatus,
        endedAt,
        durationMs: result.durationMs || endedAt - currentActivity.startedAt,
        reasoning: settleLiveReasoning(
          currentActivity.reasoning,
          activityStatus === 'done' || activityStatus === 'paused' ? 'done' : 'failed',
          endedAt,
        ),
        taskBook: result.taskBook ?? currentActivity.taskBook,
        verificationHistory: result.verificationHistory ?? currentActivity.verificationHistory,
        verificationRunning: false,
        error: paused
          ? '任务已暂停，现场已保存。'
          : result.status === 'ok'
            ? undefined
            : result.status === 'aborted'
              ? result.error || '本次运行已停止。'
              : result.error || '本次运行未生成可展示的回复。',
        steps: currentActivity.steps.length > 0 ? currentActivity.steps : taskSteps,
      }
      : undefined,
  }
  return next
}
