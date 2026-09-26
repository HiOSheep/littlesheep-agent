// Progressive disclosure rules for assistant execution activity.
import { verificationVerdictLabel } from './activity-model'
import type { AssistantTurnActivity, LiveStepEvent, LiveToolEvent, TranscriptEntry } from './types'


export function isLiveStepVisible(step: LiveStepEvent): boolean {
  return step.status !== 'pending'
    || step.startedAt !== undefined
    || step.endedAt !== undefined
    || step.toolCount > 0
    || step.activeTools > 0
}


export function visibleActivitySteps(activity: Pick<AssistantTurnActivity, 'steps'>): LiveStepEvent[] {
  return activity.steps.filter(isLiveStepVisible)
}


/**
 * True when a settled process row carries a fact the user must still see after
 * compact mode folds the rest away: a tool that did not succeed (including a
 * permission denial, which Runtime reports as `ok === false` plus the reason),
 * or a preparation attempt that failed or was aborted.
 */
export function transcriptEntryNeedsAttention(
  entry: TranscriptEntry,
  tool: LiveToolEvent | undefined,
): boolean {
  if (entry.kind === 'tool') {
    if (!tool) return false
    return tool.ok === false || Boolean(tool.error)
  }
  if (entry.kind === 'preparing') return entry.status === 'failed' || entry.status === 'aborted'
  if (entry.kind === 'reasoning') return entry.status === 'failed'
  return false
}


/** The rows compact mode keeps: only the ones that need attention. */
export function compactTranscriptEntries(
  transcript: readonly TranscriptEntry[],
  tools: readonly LiveToolEvent[],
): TranscriptEntry[] {
  const byCallId = new Map(tools.map((tool) => [tool.callId, tool]))
  return transcript.filter((entry) => (
    entry.kind === 'tool'
      ? transcriptEntryNeedsAttention(entry, byCallId.get(entry.callId))
      : transcriptEntryNeedsAttention(entry, undefined)
  ))
}


/**
 * One line for facts that live on the activity rather than on a transcript row.
 * Compact mode must not drop them: a failed, aborted or waiting turn, a
 * verification that did not pass, and a step that failed all stay readable.
 */
export function activityAttentionLine(
  activity: Pick<AssistantTurnActivity, 'status' | 'steps' | 'verificationHistory'>,
): string | null {
  const parts: string[] = []
  if (activity.status === 'failed') parts.push('本轮未完成')
  else if (activity.status === 'aborted') parts.push('本轮已停止')
  else if (activity.status === 'waiting_user') parts.push('等待你决定后继续')
  else if (activity.status === 'paused') parts.push('本轮已暂停')

  const failedSteps = activity.steps.filter((step) => step.status === 'failed')
  if (failedSteps.length > 0) parts.push(`${failedSteps.length} 个步骤失败`)

  const verification = activityVerificationLine(activity)
  if (verification) parts.push(verification)

  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * The verification verdicts that did not pass, as one line. The verdict lives on the activity
 * rather than on a transcript row, so compact mode folds it into the attention line while
 * normal mode renders this line on its own: a verdict that did not pass must stay readable in
 * both modes and must never read as a pass (UX-16).
 */
export function activityVerificationLine(
  activity: Pick<AssistantTurnActivity, 'verificationHistory'>,
): string | null {
  const notPassed = (activity.verificationHistory ?? []).filter((record) => record.verdict !== 'pass')
  if (notPassed.length === 0) return null
  const labels = [...new Set(notPassed.map((record) => verificationVerdictLabel(record.verdict)))]
  return `验证：${labels.join('、')}`
}
