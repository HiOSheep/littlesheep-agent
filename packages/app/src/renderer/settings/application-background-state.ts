import type {
  RuntimeActiveRunAction,
  RuntimeActiveRunPhase,
  RuntimeActiveRunSnapshot,
} from '@littlesheep/types'
import type { RuntimeState } from '../api'

export interface ClosePolicyOption {
  id: RuntimeState['closePolicy']
  label: string
  description: string
}

export const CLOSE_POLICY_OPTIONS: readonly ClosePolicyOption[] = [
  {
    id: 'always-background',
    label: '始终留在后台',
    description: '关闭窗口时隐藏到系统托盘，任务状态不影响关闭行为。',
  },
  {
    id: 'background-while-active',
    label: '仅在任务运行时留在后台',
    description: '有活动任务时隐藏到托盘；没有任务时关闭应用。',
  },
  {
    id: 'always-quit',
    label: '关闭窗口即退出',
    description: '关闭窗口时退出应用，活动任务也会随应用停止。',
  },
]

export function activeRunPhaseLabel(phase: RuntimeActiveRunPhase): string {
  if (phase === 'executing') return '正在执行'
  if (phase === 'verifying') return '正在验证'
  if (phase === 'finalizing') return '正在整理结果'
  return '正在规划'
}

export function activeRunStatusLabel(run: RuntimeActiveRunSnapshot): string {
  if (run.controlStatus === 'interrupt_requested') return '正在中断'
  if (run.controlStatus === 'pause_requested') return '等待暂停'
  return activeRunPhaseLabel(run.phase)
}

export function activeRunOriginLabel(origin: RuntimeActiveRunSnapshot['origin']): string {
  if (origin === 'app') return '本地应用'
  if (origin === 'channel') return '外部渠道'
  if (origin === 'cli') return '命令行'
  return '测试'
}

export function activeRunProgress(run: RuntimeActiveRunSnapshot): {
  label: string
  ratio: number | null
} {
  if (run.totalSteps <= 0) return { label: '步骤尚未生成', ratio: null }
  const completed = Math.min(run.totalSteps, Math.max(0, run.completedSteps))
  return {
    label: `${completed}/${run.totalSteps} 步`,
    ratio: completed / run.totalSteps,
  }
}

export function primaryActiveRunAction(run: RuntimeActiveRunSnapshot): RuntimeActiveRunAction | null {
  if (run.controlStatus === 'interrupt_requested') return null
  return run.controlStatus === 'pause_requested' ? 'resume' : 'pause'
}

export function replaceActiveRun(
  runs: RuntimeActiveRunSnapshot[],
  next: RuntimeActiveRunSnapshot,
): RuntimeActiveRunSnapshot[] {
  let replaced = false
  const updated = runs.map((run) => {
    if (run.runId !== next.runId) return run
    replaced = true
    return next
  })
  return replaced ? updated : [...updated, next]
}
