import { describe, expect, it } from 'vitest'
import type { HistoryActivity } from '../shared/history-activity'
import { buildTaskProgress } from './task-progress.js'

function activity(overrides: Partial<HistoryActivity> = {}): HistoryActivity {
  return {
    status: 'running', instruction: 'task', startedAt: 1, tools: [],
    steps: [
      { stepId: 'one', title: 'One', status: 'done', toolCount: 0, activeTools: 0 },
      { stepId: 'two', title: 'Two', status: 'running', toolCount: 1, activeTools: 1 },
      { stepId: 'three', title: 'Three', status: 'pending', toolCount: 0, activeTools: 0 },
    ],
    ...overrides,
  }
}

describe('task progress', () => {
  it('uses weighted real step state while executing', () => {
    expect(buildTaskProgress(activity())).toMatchObject({
      percent: 45, completedSteps: 1, totalSteps: 3, activeStep: 'Two', phase: 'executing',
    })
  })

  it('holds at 95 percent while VERIFY is running', () => {
    expect(buildTaskProgress(activity({ verificationRunning: true }))).toMatchObject({
      percent: 95, phase: 'verifying', label: '正在验证',
    })
  })

  it('reaches 100 only after the run is done', () => {
    expect(buildTaskProgress(activity({ status: 'done', verificationRunning: false }))).toMatchObject({
      percent: 100, phase: 'done', label: '任务完成',
    })
  })
})
