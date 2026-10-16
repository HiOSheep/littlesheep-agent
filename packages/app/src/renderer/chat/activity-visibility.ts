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


/** A recorded call that did not succeed, split by whether it still affects the run. */
export interface AttentionCallFailure {
  tool: LiveToolEvent
  /**
   * A later call in the *same step* succeeded, so Runtime no longer reads this outcome as
   * the step's result (the Runtime evidence settlement in
   * `harness/stages/execute/evidence-settlement.ts` currently preserves each invocation outcome).
   * The failure is history; every
   * other recorded failure is unresolved and keeps the run from being read as clean.
   */
  recovered: boolean
}

function callFailed(tool: LiveToolEvent): boolean {
  return tool.ok === false || Boolean(tool.error)
}

/**
 * The recorded call failures of one run, each marked recovered or unresolved. Calls without a
 * step ("standalone" tools) can never be recovered: the same-step rule needs a step to
 * supersede within, and guessing a different rule would let an unresolved failure read as
 * history.
 */
export function classifyCallFailures(tools: readonly LiveToolEvent[]): AttentionCallFailure[] {
  const failures: AttentionCallFailure[] = []
  tools.forEach((tool, index) => {
    if (!callFailed(tool)) return
    const recovered = Boolean(tool.stepId) && tools.some((candidate, later) => (
      later > index && candidate.stepId === tool.stepId && candidate.ok === true
    ))
    failures.push({ tool, recovered })
  })
  return failures
}

/**
 * One line for the facts that live on the activity rather than on a transcript row, so no
 * display mode and no fold can drop them: a failed, aborted or waiting turn, a step whose
 * outcome is failed or unknown, a call failure that is still unresolved, and a verification
 * verdict that did not pass. A failure a later call in the same step already superseded is
 * counted separately — it stays readable, but it must not read as an open problem.
 */
export function activityAttentionLine(
  activity: Pick<AssistantTurnActivity, 'status' | 'steps' | 'tools' | 'verificationHistory'>,
): string | null {
  const parts: string[] = []
  if (activity.status === 'failed') parts.push('本轮未完成')
  else if (activity.status === 'aborted') parts.push('本轮已停止')
  else if (activity.status === 'waiting_user') parts.push('等待你决定后继续')
  else if (activity.status === 'paused') parts.push('本轮已暂停')

  // `unknown` is not a failed step, but it is still an outcome nobody knows: a settled run
  // leaves a step `unknown` when its call never reported a result, and folding that away
  // would present a missing outcome as a finished one.
  const unresolvedSteps = activity.steps.filter((step) => step.status === 'failed' || step.status === 'unknown')
  if (unresolvedSteps.length > 0) parts.push(`${unresolvedSteps.length} 个步骤未完成`)

  const failures = classifyCallFailures(activity.tools ?? [])
  const unresolvedCalls = failures.filter((failure) => !failure.recovered).length
  const recoveredCalls = failures.length - unresolvedCalls
  if (unresolvedCalls > 0) parts.push(`${unresolvedCalls} 次调用失败`)
  if (recoveredCalls > 0) parts.push(`${recoveredCalls} 次失败已由后续调用恢复`)
  if (unresolvedCalls === 0 && recoveredCalls > 0 && activity.status === 'done') {
    parts.push('本轮无未解决失败')
  }

  const verification = activityVerificationLine(activity)
  // An unverified acceptance is a neutral fact on the turn's status trigger,
  // not a warning by itself. Evidence failures and pending decisions stay here.
  if (verification && (parts.length > 0 || activity.verificationHistory?.some((record) => record.verdict === 'fail' || record.verdict === 'needs_replan'))) parts.push(verification)

  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Preserve recorded verification verdicts as history on the process trigger. A legacy pass is
 * labeled as an old record and never presented as task acceptance.
 */
export function activityVerificationLine(
  activity: Pick<AssistantTurnActivity, 'verificationHistory'>,
): string | null {
  const records = activity.verificationHistory ?? []
  if (records.length === 0) return null
  const labels = [...new Set(records.map((record) => verificationVerdictLabel(record.verdict)))]
  return `验证：${labels.join('、')}`
}
