import type { HistoryActivity } from '../shared/history-activity'

export interface TaskProgressSnapshot {
  percent: number
  completedSteps: number
  totalSteps: number
  activeStep?: string
  phase: 'planning' | 'executing' | 'verifying' | 'done' | 'failed' | 'aborted'
  label: string
}

export function buildTaskProgress(activity: HistoryActivity): TaskProgressSnapshot {
  const totalSteps = activity.steps.length
  const completedSteps = activity.steps.filter((step) => step.status === 'done' || step.status === 'skipped').length
  const running = activity.steps.find((step) => step.status === 'running')
  const failed = activity.steps.find((step) => step.status === 'failed')
  let phase: TaskProgressSnapshot['phase']
  if (activity.status === 'aborted') phase = 'aborted'
  else if (activity.status === 'failed') phase = 'failed'
  else if (activity.status === 'done') phase = 'done'
  else if (activity.verificationRunning) phase = 'verifying'
  else if (running || completedSteps > 0) phase = 'executing'
  else phase = 'planning'

  let percent = 0
  if (phase === 'done') percent = 100
  else if (phase === 'verifying') percent = 95
  else if (totalSteps > 0) {
    const weighted = completedSteps + (running ? 0.5 : 0)
    percent = Math.min(90, Math.round((weighted / totalSteps) * 90))
  }

  const activeStep = running?.title ?? failed?.title
  const label = phase === 'planning'
    ? '正在规划'
    : phase === 'verifying'
      ? '正在验证'
      : phase === 'done'
        ? '任务完成'
        : phase === 'failed'
          ? '任务失败'
          : phase === 'aborted'
            ? '任务已停止'
            : activeStep || '正在执行'

  return { percent, completedSteps, totalSteps, activeStep, phase, label }
}
