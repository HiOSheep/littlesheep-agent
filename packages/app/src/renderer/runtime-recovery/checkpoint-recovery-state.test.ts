import { describe, expect, it } from 'vitest'
import type { ToolStreamEvent } from '@littlesheep/types'
import {
  checkpointRecoveryProgressForEvent,
  INITIAL_CHECKPOINT_RECOVERY_PROGRESS,
} from './checkpoint-recovery-state'

describe('checkpoint recovery progress', () => {
  it('advances through restore, execution, verification and finalization events', () => {
    const planned = checkpointRecoveryProgressForEvent({
      type: 'task_book',
      summary: '恢复任务书',
    } as ToolStreamEvent, INITIAL_CHECKPOINT_RECOVERY_PROGRESS)
    expect(planned).toMatchObject({ phase: 'restored', label: '任务书已恢复' })

    const executing = checkpointRecoveryProgressForEvent({
      type: 'step_start',
      stepId: 'step-1',
      title: '继续写入',
      description: '恢复未完成步骤',
    }, planned)
    expect(executing).toMatchObject({ phase: 'executing', label: '正在执行：继续写入' })

    const verifying = checkpointRecoveryProgressForEvent({
      type: 'verification_start',
    } as ToolStreamEvent, executing)
    expect(verifying).toEqual({ phase: 'verifying', label: '正在验证执行结果' })

    const finalizing = checkpointRecoveryProgressForEvent({
      type: 'final_delta',
      delta: '完成',
    } as ToolStreamEvent, verifying)
    expect(finalizing).toEqual({ phase: 'finalizing', label: '正在整理交付结果' })
  })

  it('keeps unrelated stream events from resetting visible progress', () => {
    const current = { phase: 'executing' as const, label: '正在执行：读取文件' }
    expect(checkpointRecoveryProgressForEvent({
      type: 'step_done',
      stepId: 'step-1',
    } as ToolStreamEvent, current)).toBe(current)
  })
})
