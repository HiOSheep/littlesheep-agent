import { describe, expect, it } from 'vitest'
import { asSessionId, type RuntimeActiveRunSnapshot } from '@littlesheep/types'
import {
  activeRunOriginLabel,
  activeRunProgress,
  activeRunStatusLabel,
  CLOSE_POLICY_OPTIONS,
  primaryActiveRunAction,
  replaceActiveRun,
} from './application-background-state.js'

function activeRun(overrides: Partial<RuntimeActiveRunSnapshot> = {}): RuntimeActiveRunSnapshot {
  return {
    runId: 'run-1',
    sessionId: asSessionId('session-1'),
    origin: 'app',
    startedAt: '2026-07-29T01:00:00.000Z',
    updatedAt: '2026-07-29T01:00:01.000Z',
    phase: 'executing',
    controlStatus: 'running',
    totalSteps: 4,
    completedSteps: 2,
    activeSteps: [{ stepId: 'step-3', title: '验证结果' }],
    activeToolCount: 1,
    ...overrides,
  }
}

describe('application background presentation state', () => {
  it('keeps the three close policies complete and mutually distinct', () => {
    expect(CLOSE_POLICY_OPTIONS.map((option) => option.id)).toEqual([
      'always-background',
      'background-while-active',
      'always-quit',
    ])
  })

  it('derives progress, status, origin, and the available primary control from runtime state', () => {
    expect(activeRunProgress(activeRun())).toEqual({ label: '2/4 步', ratio: 0.5 })
    expect(activeRunStatusLabel(activeRun({ phase: 'verifying' }))).toBe('正在验证')
    expect(activeRunOriginLabel('channel')).toBe('外部渠道')
    expect(primaryActiveRunAction(activeRun())).toBe('pause')
    expect(primaryActiveRunAction(activeRun({ controlStatus: 'pause_requested' }))).toBe('resume')
    expect(primaryActiveRunAction(activeRun({ controlStatus: 'interrupt_requested' }))).toBeNull()
  })

  it('clamps invalid progress and replaces only the matching runtime snapshot', () => {
    expect(activeRunProgress(activeRun({ totalSteps: 2, completedSteps: 9 }))).toEqual({ label: '2/2 步', ratio: 1 })
    expect(activeRunProgress(activeRun({ totalSteps: 0 }))).toEqual({ label: '步骤尚未生成', ratio: null })
    const next = activeRun({ controlStatus: 'pause_requested' })
    expect(replaceActiveRun([activeRun()], next)).toEqual([next])
    expect(replaceActiveRun([], next)).toEqual([next])
  })
})
