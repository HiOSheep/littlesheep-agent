import { describe, expect, it } from 'vitest'
import { isLiveStepVisible, visibleActivitySteps } from './activity-visibility'
import { upsertLiveTool } from './activity-model'
import type { LiveStepEvent } from './types'

const pendingStep: LiveStepEvent = {
  stepId: 'step-1',
  title: '尚未开始',
  status: 'pending',
  toolCount: 0,
  activeTools: 0,
}

describe('assistant activity progressive disclosure', () => {
  it('updates a completed tool in place instead of appending a second row', () => {
    const started = upsertLiveTool([], {
      callId: 'tool-1',
      name: 'read_file',
      input: { path: 'src/main.ts' },
      ok: undefined,
    })
    const completed = upsertLiveTool(started, {
      callId: 'tool-1',
      name: 'read_file',
      ok: true,
      output: 'done',
    })

    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ callId: 'tool-1', ok: true, output: 'done' })
  })

  it('keeps untouched task-book steps hidden until execution reaches them', () => {
    expect(isLiveStepVisible(pendingStep)).toBe(false)
    expect(visibleActivitySteps({ steps: [pendingStep] })).toEqual([])
  })

  it('reveals a step as soon as status, timing, or tool activity proves it started', () => {
    const startedByStatus = { ...pendingStep, status: 'running' as const }
    const startedByTime = { ...pendingStep, startedAt: 0 }
    const startedByTool = { ...pendingStep, toolCount: 1 }

    expect(isLiveStepVisible(startedByStatus)).toBe(true)
    expect(isLiveStepVisible(startedByTime)).toBe(true)
    expect(isLiveStepVisible(startedByTool)).toBe(true)
    expect(visibleActivitySteps({ steps: [pendingStep, startedByStatus] })).toEqual([startedByStatus])
  })
})
