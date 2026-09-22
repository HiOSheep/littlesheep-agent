// Pure labels and progress reduction for the startup recovery control surface.

import type { ToolStreamEvent } from '@littlesheep/types'
import type {
  LocalAppRunCheckpointDiagnostics,
  LocalAppRunCheckpointSummary,
} from '../../shared/run-checkpoint-contracts'

export interface CheckpointRecoveryProgress {
  phase: 'preparing' | 'restored' | 'executing' | 'verifying' | 'finalizing'
  label: string
  detail?: string
}

export const INITIAL_CHECKPOINT_RECOVERY_PROGRESS: CheckpointRecoveryProgress = {
  phase: 'preparing',
  label: '正在恢复执行现场',
}

export function checkpointRecoveryProgressForEvent(
  event: ToolStreamEvent,
  current: CheckpointRecoveryProgress,
): CheckpointRecoveryProgress {
  if (event.type === 'task_book') {
    return {
      phase: 'restored',
      label: '任务书已恢复',
      detail: bounded(event.taskBook?.goal ?? event.summary),
    }
  }
  if (event.type === 'step_start') {
    return {
      phase: 'executing',
      label: event.title ? `正在执行：${event.title}` : '正在执行下一步',
      detail: bounded(event.description),
    }
  }
  if (event.type === 'tool_start') {
    return {
      phase: 'executing',
      label: event.name ? `正在使用 ${event.name}` : '正在调用工具',
      detail: current.phase === 'executing' ? current.detail : undefined,
    }
  }
  if (event.type === 'tool_end') {
    return {
      phase: 'executing',
      label: event.ok === false ? '工具执行未完成' : '工具执行完成',
      detail: bounded(event.error ?? event.name),
    }
  }
  if (event.type === 'verification_start') {
    return { phase: 'verifying', label: '正在验证执行结果' }
  }
  if (event.type === 'verification') {
    return {
      phase: 'verifying',
      label: event.verification?.verdict === 'pass'
        ? '验证通过'
        : event.verification?.verdict === 'unverified' ? '未验证' : '验证结果已返回',
      detail: bounded(event.verification?.reason ?? event.summary),
    }
  }
  if (event.type === 'final_delta') {
    return { phase: 'finalizing', label: '正在整理交付结果' }
  }
  return current
}

export function checkpointStageLabel(stage: string): string {
  // `decide`, `evolve` and `capture` are historical stage names: checkpoints
  // written before the second execution system was deleted can still carry them,
  // so the reader keeps labels for them even though no stage routes there.
  const labels: Record<string, string> = {
    enter: '进入任务',
    classify: '判断需求',
    reply: '直接回应',
    ask_user: '等待补充',
    decide: '制定任务书',
    execute: '执行任务',
    recover: '恢复处理',
    verify: '验证结果',
    evolve: '沉淀能力',
    capture: '记录现场',
    finalize: '整理交付',
  }
  return labels[stage] ?? stage
}

export function checkpointBlockerLabel(reason: string): string {
  if (reason.includes('no resumable runtime state')) return '这个检查点来自旧版本，只能查看或放弃。'
  if (reason.includes('attachments that are not restorable')) return '原任务包含无法从检查点恢复的附件。'
  if (reason.includes('model does not match')) return '当前模型与创建检查点时使用的模型不同。'
  if (reason.includes('without verified completion evidence')) return '存在无法确认是否完成的外部操作，LS 不会自动重放。'
  if (reason.includes('active resume lease')) return '这个任务正在另一个恢复流程中执行。'
  if (reason.includes('already been resumed')) return '这个检查点已经恢复过。'
  if (reason.includes('source run has already completed')) return '原任务已经完成，这个检查点不需要恢复。'
  if (reason.includes('explicitly abandoned')) return '这个检查点已经被放弃。'
  return reason
}

export function compactDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0 秒'
  if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1_000))} 秒`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1_000)
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
}

export type CheckpointRecoveryEntryKind =
  | 'none'
  | 'discovery-failed'
  | 'active'
  | 'waiting-input'
  | 'pending'
  | 'damaged'

export interface CheckpointRecoveryEntry {
  kind: CheckpointRecoveryEntryKind
  /** Quiet trigger label. Empty when there is nothing to show. */
  label: string
  /** Hover and accessible explanation. */
  title: string
  /** Counter next to the label; 0 hides it. */
  count: number
  /** A failed discovery is retried; a known state opens the dialog. */
  action: 'none' | 'open' | 'retry'
}

export interface CheckpointRecoveryEntryInput {
  checkpoints: readonly LocalAppRunCheckpointSummary[]
  diagnostics: LocalAppRunCheckpointDiagnostics
  /** The last discovery request failed, so the current state is unknown. */
  discoveryFailed: boolean
  resuming: boolean
  stopRequested: boolean
}

/**
 * Derives the one quiet entry the recovery surface shows. A failed discovery
 * and unreadable records are facts the user must be able to see even when no
 * valid checkpoint exists, and they must not be presented as "nothing pending".
 */
export function checkpointRecoveryEntry(input: CheckpointRecoveryEntryInput): CheckpointRecoveryEntry {
  const total = input.checkpoints.length
  if (input.discoveryFailed) {
    return {
      kind: 'discovery-failed',
      label: '恢复检查失败',
      title: '未能读取未完成任务；点击重试',
      count: 0,
      action: 'retry',
    }
  }
  if (input.resuming) {
    return {
      kind: 'active',
      label: input.stopRequested ? '正在停止恢复' : '任务恢复中',
      title: input.stopRequested ? '正在停止并保存执行现场' : '查看正在恢复的任务',
      count: total,
      action: 'open',
    }
  }
  if (total > 0) {
    const waiting = input.checkpoints.filter((checkpoint) => checkpoint.waitingForInput && checkpoint.resumable).length
    return {
      kind: waiting > 0 ? 'waiting-input' : 'pending',
      label: waiting > 0 ? '待补充信息' : '待恢复任务',
      title: waiting > 0
        ? `${waiting} 个未完成任务需要补充信息后才能继续`
        : `查看 ${total} 个未完成任务`,
      count: total,
      action: 'open',
    }
  }
  if (checkpointRecoveryDiagnosticText(input.diagnostics)) {
    return {
      kind: 'damaged',
      label: '恢复记录异常',
      title: '有恢复记录无法读取，原文件已保留；点击查看',
      count: input.diagnostics.invalidFiles,
      action: 'open',
    }
  }
  return { kind: 'none', label: '', title: '', count: 0, action: 'none' }
}

/** Shared wording for unreadable or incomplete recovery records. */
export function checkpointRecoveryDiagnosticText(
  diagnostics: LocalAppRunCheckpointDiagnostics,
): string | null {
  const parts: string[] = []
  if (diagnostics.invalidFiles > 0) parts.push(`${diagnostics.invalidFiles} 份恢复记录无法读取`)
  if (diagnostics.warningCount > 0) parts.push(`${diagnostics.warningCount} 处恢复记录不完整`)
  if (parts.length === 0) return null
  return `另有 ${parts.join('、')}；LS 已保留原文件并停止自动处理。`
}

function bounded(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`
}
