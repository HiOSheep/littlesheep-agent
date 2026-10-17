import type { TaskOutcome, TaskRequirementStatus } from '@littlesheep/types'
import type { AssistantTurnActivity } from './types'

export type TaskOutcomeBadge = { label: string; tone: 'good' | 'danger' | 'muted' | 'blocked' }

const requirementBadges: Record<TaskRequirementStatus, TaskOutcomeBadge> = {
  passed: { label: '已验证通过', tone: 'good' },
  failed: { label: '检查未通过', tone: 'danger' },
  unverified: { label: '尚未验证', tone: 'muted' },
  blocked: { label: '检查受阻', tone: 'blocked' },
}

const reasonLabels: Record<string, string> = {
  file_content_mismatch: '文件内容与要求不一致',
  file_missing: '文件不存在，无法检查',
  no_independent_check: '尚未执行独立检查',
  no_settled_write_effect: '写入结果尚未确认结算',
  unknown_effect: '副作用结果不确定，需要核实',
  provider_unsettled: '模型请求结果尚未结算',
  requirements_unknown: '无法确认完整的要求清单',
  legacy_outcome_unavailable: '此历史运行没有验收记录',
  task_outcome_not_durably_settled: '验收记录尚未可靠保存',
  execution_cancelled: '任务已取消',
  execution_failed: '运行失败，未取得完整验收结果',
  permission_denied: '缺少所需权限',
  execution_blocked: '执行受到阻断',
  outcome_pending_terminal_settlement: '任务结果仍在结算中',
}

export function requirementBadge(status: TaskRequirementStatus): TaskOutcomeBadge {
  return requirementBadges[status]
}

export function reasonLabel(reasonCode: string | undefined): string | undefined {
  return reasonCode ? reasonLabels[reasonCode] ?? '原因暂不可用' : undefined
}

export function executionStatusLabel(status: TaskOutcome['execution']['status']): string {
  switch (status) {
    case 'completed': return '执行已结束'
    case 'failed': return '执行失败'
    case 'cancelled': return '已取消'
    case 'blocked': return '受到阻断'
    default: return '执行状态无法确认'
  }
}

export function taskOutcomeStatusLabel(outcome: TaskOutcome, activityStatus: AssistantTurnActivity['status']): string {
  // A persisted outcome cannot make a failed or interrupted turn look successful.
  if (activityStatus !== 'done' && outcome.status === 'completed') return '执行未正常结束，无法确认任务已完成'
  switch (outcome.status) {
    case 'completed': return '已按明确的验收条件通过'
    case 'partially_completed':
      return outcome.requirements.some((requirement) => requirement.status === 'passed')
        ? '部分要求已通过，仍有未满足项'
        : '仍有要求未满足或未验证'
    case 'blocked': return '任务受到阻断'
    case 'cancelled': return '任务已取消，保留取消前可确认的成果'
    default: return '无法确认目标是否全部满足'
  }
}

/** Only accept bounded workspace-relative references for display and file opening. */
export function workspaceRelativeResource(resourceRef: string): string | undefined {
  if (!resourceRef.startsWith('workspace:')) return undefined
  const path = resourceRef.slice('workspace:'.length)
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')
    || /^[A-Za-z]:/u.test(path)) return undefined
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined
  return path
}

export function hasSuccessfulFileMutation(activity: AssistantTurnActivity): boolean {
  return activity.tools.some((tool) => (
    (tool.name === 'write' || tool.name === 'edit')
    && (tool.ok === true || tool.invocationStatus === 'succeeded')
  ))
}

export function shouldShowTaskOutcome(activity: AssistantTurnActivity): boolean {
  if (activity.status === 'running' || activity.status === 'paused' || activity.status === 'waiting_user') return false
  const outcome = activity.taskOutcome
  if (!outcome) return hasSuccessfulFileMutation(activity)
  if (outcome.execution.reasonCode === 'outcome_pending_terminal_settlement') return false
  if (outcome.requirements.length || outcome.evidence.length || outcome.artifacts.length) return true
  const actionableRemaining = outcome.remaining.some((item) => item.reasonCode !== 'requirements_unknown'
    && item.reasonCode !== 'legacy_outcome_unavailable')
  if (actionableRemaining) return true
  if (outcome.status === 'unknown') return hasSuccessfulFileMutation(activity)
  return true
}
