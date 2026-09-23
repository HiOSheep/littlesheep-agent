import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { ToolStreamEvent } from '@littlesheep/types'
import type { LocalAppRunCheckpointSummary } from '../../shared/run-checkpoint-contracts'
import {
  checkpointRecoveryDiagnosticText,
  checkpointRecoveryEntry,
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

function checkpoint(overrides: Partial<LocalAppRunCheckpointSummary> = {}): LocalAppRunCheckpointSummary {
  return {
    id: 'checkpoint-1',
    sourceRunId: 'run-1',
    sessionId: 'session-1',
    status: 'paused',
    currentStage: 'execute',
    createdAt: '2026-09-22T10:00:00.000Z',
    reason: 'app closed mid-run',
    resumable: true,
    blockers: [],
    waitingForInput: false,
    taskBookRevision: 1,
    progress: { completedSteps: 1, failedSteps: 0, totalSteps: 3 },
    sideEffects: { total: 1, succeeded: 1, failed: 0, unverified: 0 },
    ...overrides,
  }
}

const CLEAN_DIAGNOSTICS = { invalidFiles: 0, warningCount: 0 }

describe('checkpoint recovery entry', () => {
  it('exposes a failed discovery instead of an empty pending list', () => {
    const entry = checkpointRecoveryEntry({
      checkpoints: [],
      diagnostics: CLEAN_DIAGNOSTICS,
      discoveryFailed: true,
      resuming: false,
      stopRequested: false,
    })

    expect(entry).toMatchObject({ kind: 'discovery-failed', label: '恢复检查失败', action: 'retry' })
    // The failed state is the only one that retries instead of opening the dialog.
    expect(entry.title).toContain('重试')
  })

  it('keeps a failed discovery ahead of damaged records and known checkpoints', () => {
    const entry = checkpointRecoveryEntry({
      checkpoints: [checkpoint()],
      diagnostics: { invalidFiles: 2, warningCount: 1 },
      discoveryFailed: true,
      resuming: false,
      stopRequested: false,
    })

    expect(entry.kind).toBe('discovery-failed')
  })

  it('shows unreadable records when no valid checkpoint exists', () => {
    const entry = checkpointRecoveryEntry({
      checkpoints: [],
      diagnostics: { invalidFiles: 2, warningCount: 0 },
      discoveryFailed: false,
      resuming: false,
      stopRequested: false,
    })

    expect(entry).toMatchObject({ kind: 'damaged', label: '恢复记录异常', count: 2, action: 'open' })
  })

  it('separates waiting for user input from ordinary pending work', () => {
    const waiting = checkpointRecoveryEntry({
      checkpoints: [checkpoint({ waitingForInput: true })],
      diagnostics: CLEAN_DIAGNOSTICS,
      discoveryFailed: false,
      resuming: false,
      stopRequested: false,
    })
    expect(waiting).toMatchObject({ kind: 'waiting-input', label: '待补充信息', count: 1 })
    expect(waiting.title).toContain('需要补充信息')

    const blockedWaiting = checkpointRecoveryEntry({
      checkpoints: [checkpoint({ waitingForInput: true, resumable: false })],
      diagnostics: CLEAN_DIAGNOSTICS,
      discoveryFailed: false,
      resuming: false,
      stopRequested: false,
    })
    expect(blockedWaiting.kind).toBe('pending')

    const pending = checkpointRecoveryEntry({
      checkpoints: [checkpoint(), checkpoint({ id: 'checkpoint-2' })],
      diagnostics: CLEAN_DIAGNOSTICS,
      discoveryFailed: false,
      resuming: false,
      stopRequested: false,
    })
    expect(pending).toMatchObject({ kind: 'pending', label: '待恢复任务', count: 2 })
  })

  it('reports an active resume and its stop request', () => {
    const resuming = checkpointRecoveryEntry({
      checkpoints: [checkpoint()],
      diagnostics: CLEAN_DIAGNOSTICS,
      discoveryFailed: false,
      resuming: true,
      stopRequested: false,
    })
    expect(resuming).toMatchObject({ kind: 'active', label: '任务恢复中' })

    const stopping = checkpointRecoveryEntry({
      checkpoints: [checkpoint()],
      diagnostics: CLEAN_DIAGNOSTICS,
      discoveryFailed: false,
      resuming: true,
      stopRequested: true,
    })
    expect(stopping.label).toBe('正在停止恢复')
  })

  it('stays silent only when the state is known and clean', () => {
    const entry = checkpointRecoveryEntry({
      checkpoints: [],
      diagnostics: CLEAN_DIAGNOSTICS,
      discoveryFailed: false,
      resuming: false,
      stopRequested: false,
    })

    expect(entry).toEqual({ kind: 'none', label: '', title: '', count: 0, action: 'none' })
  })

  it('names both kinds of unreadable records', () => {
    expect(checkpointRecoveryDiagnosticText(CLEAN_DIAGNOSTICS)).toBeNull()
    expect(checkpointRecoveryDiagnosticText({ invalidFiles: 1, warningCount: 0 })).toContain('1 份恢复记录无法读取')
    expect(checkpointRecoveryDiagnosticText({ invalidFiles: 0, warningCount: 3 })).toContain('3 处恢复记录不完整')
    expect(checkpointRecoveryDiagnosticText({ invalidFiles: 2, warningCount: 1 })).toContain('2 份恢复记录无法读取、1 处恢复记录不完整')
  })
})

describe('checkpoint recovery wiring', () => {
  it('keeps the quiet trigger, the retry and the empty state honest', async () => {
    const [view, hook] = await Promise.all([
      readFile(new URL('./checkpoint-recovery.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./use-checkpoint-recovery.ts', import.meta.url), 'utf8'),
    ])

    expect(view).toContain("recovery.entry.kind !== 'none' && !recovery.visible")
    expect(view).toContain("recovery.entry.action === 'retry' ? recovery.retryDiscovery : recovery.open")
    expect(view).toContain('recovery.discoveryFailed\n                  ? \'这次没有读取成功')
    expect(view).toContain('重新检查')
    expect(hook).toContain('setDiscoveryFailed(true)')
    expect(hook).toContain('setDiscoveryFailed(false)')
    expect(hook).toContain('function retryDiscovery()')
    // Retrying re-reads the list; it must not resume anything by itself.
    expect(hook).not.toContain('resumeSelected(checkpoint)\n    void refreshCheckpoints')
    // Startup discovery stays silent (it never opens the dialog by itself) and
    // waits for real execution readiness instead of failing against a Runtime
    // that is merely still starting.
    expect(hook).toContain('void refreshCheckpoints(false)\n    }')
    expect(hook).toContain('subscribeRuntimeReadiness((state) => {')
    expect(hook).toContain("if (state.state === 'ready') runDiscovery()")
    expect(hook).toContain('if (isExecutionReady()) runDiscovery()')
    expect(hook).not.toContain('void refreshCheckpoints(false)\n  }, [])')
  })
})
