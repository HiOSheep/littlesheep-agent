import { describe, expect, it } from 'vitest'
import { unknownTaskOutcome } from '@littlesheep/types'
import type { AssistantTurnActivity } from './types'
import { hasSuccessfulFileMutation, shouldShowTaskOutcome, taskOutcomeStatusLabel, workspaceRelativeResource } from './task-outcome-presentation'

function activity(overrides: Partial<AssistantTurnActivity> = {}): AssistantTurnActivity {
  return { status: 'done', instruction: 'task', startedAt: 1, steps: [], tools: [], ...overrides }
}

describe('Task Outcome UI projection', () => {
  it('hides generic unknown outcomes for ordinary conversation and shows a missing record after a successful file write', () => {
    const ordinary = activity({ taskOutcome: unknownTaskOutcome('run-1') })
    expect(shouldShowTaskOutcome(ordinary)).toBe(false)

    const fileWrite = activity({
      taskOutcome: unknownTaskOutcome('run-1'),
      tools: [{ callId: 'write-1', name: 'write', ok: true }],
    })
    expect(hasSuccessfulFileMutation(fileWrite)).toBe(true)
    expect(shouldShowTaskOutcome(fileWrite)).toBe(true)
  })

  it('does not show an interim or pending-settlement Outcome as terminal', () => {
    const pending = unknownTaskOutcome('run-1')
    pending.execution.reasonCode = 'outcome_pending_terminal_settlement'
    expect(shouldShowTaskOutcome(activity({ status: 'running', taskOutcome: pending }))).toBe(false)
    expect(shouldShowTaskOutcome(activity({ status: 'waiting_user', taskOutcome: pending }))).toBe(false)
  })

  it('does not describe an all-failed partial outcome as partly passed', () => {
    const outcome = unknownTaskOutcome('run-1')
    outcome.status = 'partially_completed'
    outcome.requirements = [{ id: 'req-1', sourceMessageId: 'user-1', origin: 'user_explicit', status: 'failed', evidenceRefs: [] }]
    expect(taskOutcomeStatusLabel(outcome, 'done')).toBe('仍有要求未满足或未验证')
  })

  it('accepts only bounded workspace-relative resource references', () => {
    expect(workspaceRelativeResource('workspace:results/result.txt')).toBe('results/result.txt')
    for (const value of [
      'C:\\Users\\private\\result.txt',
      'workspace:/absolute.txt',
      'workspace:../outside.txt',
      'workspace:folder/../../outside.txt',
      'workspace:C:/private.txt',
      'workspace:folder\\result.txt',
    ]) expect(workspaceRelativeResource(value)).toBeUndefined()
  })
})
