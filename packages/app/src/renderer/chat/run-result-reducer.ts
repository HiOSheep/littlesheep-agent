// Reduces a completed run into the active assistant turn without owning stream lifecycle state.
import type { RunResult } from '../api'
import { buildArtifactsFromToolCalls, buildTraceData, settleLiveReasoning, taskStepToLiveStep } from './activity-model'
import type { ChatMessage, TranscriptEntry } from './types'
import { projectConversationContext } from './context-projections'
import { applyInvocationStatus, runActivityOutcome } from '../../shared/history-activity'
import { aggregateRunUsage } from '../../shared/run-usage'
import { replaceAssistantPreview } from './live-message-updates'

export function reduceCompletedRunMessages(
  messages: ChatMessage[],
  result: RunResult,
): ChatMessage[] {
  const finalText = result.status === 'ok'
    ? result.finalReplySettlement?.status === 'settled' ? result.finalReplySettlement.reply
      : result.finalReplySettlement === undefined ? result.reply : '' : ''
  messages = replaceAssistantPreview(messages, finalText)
  const last = messages[messages.length - 1]
  if (last?.role !== 'assistant') return messages

  const endedAt = Date.now()
  const traceData = buildTraceData(result)
  const artifacts = buildArtifactsFromToolCalls(traceData.toolCalls)
  const taskSteps = result.taskExecution?.steps?.map((step) => taskStepToLiveStep(step)) ?? []
  const currentActivity = last.activity
  const hasExecutionProgress = Boolean(
    result.taskExecution?.steps?.length
      || result.toolInvocations?.length
      || result.messages?.some((message) => message.content.some((block) => (
        typeof block === 'object'
        && block !== null
        && 'type' in block
        && ((block as { type?: unknown }).type === 'tool_calls' || (block as { type?: unknown }).type === 'tool_result')
      ))),
  )
  const outcome = runActivityOutcome(result)
  const activityStatus = outcome.status
  const waiting = activityStatus === 'waiting_user' || activityStatus === 'paused'
  const priorSteps = new Map(currentActivity?.steps.map((step) => [step.stepId, step]))
  const steps = (result.taskExecution?.steps !== undefined ? taskSteps : currentActivity?.steps ?? []).map((step) => ({
    ...step,
    startedAt: step.startedAt ?? priorSteps.get(step.stepId)?.startedAt,
    endedAt: step.endedAt ?? endedAt,
    activeTools: 0,
    status: step.status === 'running' ? waiting ? 'pending' as const : 'unknown' as const : step.status,
  }))
  const tools = new Map(currentActivity?.tools.map((tool) => [tool.callId, tool]))
  for (const record of result.toolInvocations ?? []) {
    tools.set(record.callId, applyInvocationStatus(tools.get(record.callId), record, endedAt))
  }
  const settledReply = result.finalReplySettlement?.status === 'settled'
    ? result.finalReplySettlement.reply
    : result.finalReplySettlement === undefined
      ? result.reply
      : ''
  const next = [...messages]
  next[next.length - 1] = {
    ...last,
    timestamp: new Date(endedAt).toISOString(),
    // A streamed delta/replace is a preview. Once the run settles, the
    // authoritative settlement must replace that preview even when it differs.
    text: result.status === 'ok' ? settledReply : '',
    ...traceData,
    usage: aggregateRunUsage(result.contextSnapshots, result.usage),
    modelRef: result.contextSnapshots?.at(-1)
      ? `${result.contextSnapshots.at(-1)!.provider}/${result.contextSnapshots.at(-1)!.model}`
      : last.modelRef,
    artifacts,
    activityCollapsed: true,
    webEvidence: result.webEvidence,
    activity: currentActivity
      ? {
        ...currentActivity,
        visibility: hasExecutionProgress ? 'progress' : currentActivity.visibility,
        ...outcome,
        endedAt,
        durationMs: result.durationMs || endedAt - currentActivity.startedAt,
        reasoning: settleLiveReasoning(
          currentActivity.reasoning,
          activityStatus === 'done' || waiting ? 'done' : activityStatus === 'aborted' ? 'aborted' : 'failed',
          endedAt,
        ),
        taskBook: result.taskBook ?? currentActivity.taskBook,
        verificationHistory: result.verificationHistory ?? currentActivity.verificationHistory,
        verificationRunning: false,
        error: outcome.error ?? (result.status === 'ok'
            ? undefined
            : result.status === 'aborted'
              ? result.error || '本次运行已停止。'
              : result.error || '本次运行未生成可展示的回复。'),
        steps,
        tools: [...tools.values()].map((tool) => ({
          ...tool,
          endedAt: tool.endedAt ?? endedAt,
          error: tool.error ?? (tool.ok === undefined ? '未收到工具最终结果。' : undefined),
        })),
        contextProjections: projectConversationContext(result.contextSnapshots),
        ...(result.conversationTranscript?.length ? {
          transcript: reconcileTranscript(currentActivity.transcript ?? [], result.conversationTranscript),
        } : {}),
      }
      : undefined,
  }
  return next
}

/** Canonical prose/tool snapshots update their seats without moving thinking or failed preparations. */
function reconcileTranscript(live: TranscriptEntry[], canonical: NonNullable<RunResult['conversationTranscript']>): TranscriptEntry[] {
  const next = [...live]
  for (let index = canonical.length - 1; index >= 0; index--) {
    const entry = canonical[index]!
    const current = next.findIndex((item) => item.id === entry.id)
    if (current >= 0) next[current] = entry
    else {
      const following = next.findIndex((item) => item.id === canonical[index + 1]?.id)
      if (following >= 0) next.splice(following, 0, entry)
      else next.push(entry)
    }
  }
  return next
}
