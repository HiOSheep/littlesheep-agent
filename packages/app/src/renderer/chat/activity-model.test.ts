import { describe, expect, it } from 'vitest'
import type { VerificationRecord } from '@littlesheep/types'
import { hasExecutionStarted, isLiveStepVisible, visibleActivitySteps } from './activity-visibility'
import type { AssistantTurnActivity, LiveStepEvent } from './types'

const pendingStep: LiveStepEvent = {
  stepId: 'step-1',
  title: '尚未开始',
  status: 'pending',
  toolCount: 0,
  activeTools: 0,
}

function activity(
  overrides: Partial<Pick<AssistantTurnActivity, 'steps' | 'tools' | 'verificationRunning' | 'verificationHistory'>> = {},
): Pick<AssistantTurnActivity, 'steps' | 'tools' | 'verificationRunning' | 'verificationHistory'> {
  return {
    steps: [],
    tools: [],
    verificationRunning: false,
    verificationHistory: [],
    ...overrides,
  }
}

describe('assistant activity progressive disclosure', () => {
  it('keeps untouched task-book steps hidden until execution reaches them', () => {
    expect(isLiveStepVisible(pendingStep)).toBe(false)
    expect(visibleActivitySteps(activity({ steps: [pendingStep] }))).toEqual([])
    expect(hasExecutionStarted(activity({ steps: [pendingStep] }))).toBe(false)
  })

  it('reveals a step as soon as status, timing, or tool activity proves it started', () => {
    const startedByStatus = { ...pendingStep, status: 'running' as const }
    const startedByTime = { ...pendingStep, startedAt: 0 }
    const startedByTool = { ...pendingStep, toolCount: 1 }

    expect(isLiveStepVisible(startedByStatus)).toBe(true)
    expect(isLiveStepVisible(startedByTime)).toBe(true)
    expect(isLiveStepVisible(startedByTool)).toBe(true)
    expect(visibleActivitySteps(activity({ steps: [pendingStep, startedByStatus] }))).toEqual([startedByStatus])
  })

  it('reveals execution for standalone tools and verification events', () => {
    expect(hasExecutionStarted(activity({
      tools: [{ callId: 'tool-1', name: 'read', startedAt: 1 }],
    }))).toBe(true)
    expect(hasExecutionStarted(activity({ verificationRunning: true }))).toBe(true)

    const verification: VerificationRecord = {
      attempt: 1,
      verdict: 'pass',
      reason: '已达到验收标准',
      verifiedAt: '2026-07-20T00:00:00.000Z',
      source: 'structural',
    }
    expect(hasExecutionStarted(activity({ verificationHistory: [verification] }))).toBe(true)
  })
})
