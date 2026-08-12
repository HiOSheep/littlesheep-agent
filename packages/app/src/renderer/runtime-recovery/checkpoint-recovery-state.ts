// Pure labels and progress reduction for the startup recovery control surface.

import type { ToolStreamEvent } from '@littlesheep/types'

export interface CheckpointRecoveryProgress {
  phase: 'preparing' | 'planning' | 'executing' | 'verifying' | 'finalizing'
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
      phase: 'planning',
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
      label: event.verification?.verdict === 'pass' ? '验证通过' : '验证结果已返回',
      detail: bounded(event.verification?.reason ?? event.summary),
    }
  }
  if (event.type === 'final_delta') {
    return { phase: 'finalizing', label: '正在整理交付结果' }
  }
  return current
}

export function checkpointStageLabel(stage: string): string {
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

function bounded(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 179)}…`
}
