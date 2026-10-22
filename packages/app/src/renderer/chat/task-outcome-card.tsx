import type { TaskEvidenceReference, TaskOutcome } from '@littlesheep/types'
import type { AssistantTurnActivity } from './types'
import {
  acceptanceTone,
  executionStatusLabel,
  hasSuccessfulFileMutation,
  isAcceptanceUnverified,
  reasonLabel,
  requirementBadge,
  shouldShowTaskOutcome,
  taskOutcomeAcceptanceState,
  taskOutcomeStatusLabel,
  workspaceRelativeResource,
} from './task-outcome-presentation'

export function TaskOutcomeCard({
  activity,
  onOpenFile,
}: {
  activity: AssistantTurnActivity
  onOpenFile: (path: string) => void
}) {
  if (!shouldShowTaskOutcome(activity)) return null
  const outcome = activity.taskOutcome
  if (!outcome || (outcome.execution.reasonCode === 'legacy_outcome_unavailable'
    && outcome.requirements.length === 0 && outcome.artifacts.length === 0 && outcome.evidence.length === 0)) {
    return (
      <section className="task-outcome-card is-unknown is-unresolved" aria-label="任务验收结果" role="status">
        <div className="task-outcome-heading">
          <strong>任务验收</strong>
          <span className="task-outcome-badge unverified">缺少验收记录</span>
        </div>
        <p className="task-outcome-claim-note">模型最终回复里的完成声明属于 Agent 声明，不构成验收通过；本卡片只依据 Runtime 记录。</p>
        <p>文件写入操作成功不代表内容已通过检查；当前没有可回溯的独立检查结果。</p>
      </section>
    )
  }

  const inventoryLabel = outcome.requirementInventory === 'complete'
    ? '验收清单已识别'
    : outcome.requirementInventory === 'partial' ? '验收清单不完整' : '验收清单无法确认'
  const evidenceById = new Map(outcome.evidence.map((item) => [item.id, item]))
  const acceptanceState = taskOutcomeAcceptanceState(outcome, activity.status)
  const acceptanceUnverified = isAcceptanceUnverified(outcome)
  const completed = acceptanceState === 'completed'
  return (
    <section
      className={`task-outcome-card${completed ? ' is-completed' : ' is-unresolved'}${acceptanceUnverified ? ' is-unverified' : ''}`}
      data-acceptance={acceptanceState}
      aria-label="任务验收结果"
      role="status"
    >
      <div className="task-outcome-heading">
        <strong>任务验收</strong>
        <span className={`task-outcome-badge ${acceptanceTone(acceptanceState)}`}>
          {taskOutcomeStatusLabel(outcome, activity.status)}
        </span>
      </div>
      <p className="task-outcome-claim-note">模型最终回复里的完成声明属于 Agent 声明，不构成验收通过；本卡片只依据 Runtime 记录。</p>
      {acceptanceUnverified && (
        <p className="task-outcome-claim-note">
          本 Run 缺少可确认的独立检查证据；验证范围仅限 Runtime 已记录的要求。
        </p>
      )}
      <div className="task-outcome-meta">
        <span>执行：{executionStatusLabel(outcome.execution.status)}</span>
        <span>{inventoryLabel}</span>
      </div>

      {outcome.requirements.length > 0 && (
        <div className="task-outcome-section">
          <h4>要求验收</h4>
          <ul className="task-outcome-list">
            {outcome.requirements.map((requirement, index) => {
              const badge = requirementBadge(requirement.status)
              const evidence = requirement.evidenceRefs
                .map((id) => evidenceById.get(id))
                .filter((item): item is TaskEvidenceReference => item !== undefined)
              const reason = reasonLabel(requirement.reasonCode)
              return (
                <li className="task-outcome-requirement" key={requirement.id}>
                  <div className="task-outcome-row">
                    <span>要求 {index + 1}</span>
                    <span className={`task-outcome-badge ${badge.tone}`}>{badge.label}</span>
                  </div>
                  {reason && <p className="task-outcome-reason">{reason}</p>}
                  {evidence.length > 0 && (
                    <details className="task-outcome-evidence">
                      <summary>查看检查依据（{evidence.length}）</summary>
                      <EvidenceList evidence={evidence} />
                    </details>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {outcome.artifacts.length > 0 && (
        <div className="task-outcome-section">
          <h4>产物</h4>
          <ul className="task-outcome-list">
            {outcome.artifacts.map((artifact, index) => {
              const path = workspaceRelativeResource(artifact.resourceRef)
              const badge = requirementBadge(artifact.verification)
              const checks = artifact.evidenceRefs
                .map((id) => evidenceById.get(id))
                .filter((item): item is TaskEvidenceReference => item !== undefined)
              return (
                <li className="task-outcome-artifact" key={`${artifact.resourceRef}:${index}`}>
                  <div className="task-outcome-row">
                    {path
                      ? <button type="button" className="task-outcome-file" onClick={() => onOpenFile(path)}>{path}</button>
                      : <span>受限资源</span>}
                    <span className={`task-outcome-badge ${badge.tone}`}>{badge.label}</span>
                  </div>
                  <p className="task-outcome-reason">{artifactActionLabel(artifact.action)} · {artifactVerificationDetail(artifact, checks)}</p>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {outcome.remaining.length > 0 && (
        <div className="task-outcome-section">
          <h4>剩余工作</h4>
          <ul className="task-outcome-list task-outcome-remaining">
            {outcome.remaining.map((item, index) => (
              <li key={`${item.requirementId ?? 'run'}:${item.reasonCode}:${index}`}>
                {item.requirementId
                  ? `要求 ${Math.max(1, outcome.requirements.findIndex((requirement) => requirement.id === item.requirementId) + 1)}：`
                  : ''}
                {reasonLabel(item.reasonCode)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {outcome.status === 'unknown' && outcome.requirements.length === 0 && outcome.artifacts.length === 0
        && hasSuccessfulFileMutation(activity) && (
          <p className="task-outcome-reason">没有可展示的要求验收记录；文件写入成功本身不代表内容已通过检查。</p>
        )}
    </section>
  )
}

function EvidenceList({ evidence }: { evidence: TaskEvidenceReference[] }) {
  return (
    <ul className="task-outcome-evidence-list">
      {evidence.map((item) => (
        <li key={item.id}>
          <span>{evidenceKindLabel(item.kind)} · {evidenceStatusLabel(item.status)}</span>
          {item.resourceRef && workspaceRelativeResource(item.resourceRef) && (
            <code>{workspaceRelativeResource(item.resourceRef)}</code>
          )}
          {item.contentHash && <code>检查时版本 SHA-256 {item.contentHash.slice(0, 12)}</code>}
          {item.checkedAt && <time dateTime={item.checkedAt}>检查时间 {item.checkedAt}</time>}
          {safeReferenceSuffix(item.sourceRef) && <code>记录 · {safeReferenceSuffix(item.sourceRef)}</code>}
          {item.kind === 'requirement_check' && item.contentHash && (
            <p>结果只对应检查时的文件版本；文件之后可能变化，历史记录不会自动复核当前文件。</p>
          )}
        </li>
      ))}
    </ul>
  )
}

function evidenceKindLabel(kind: TaskEvidenceReference['kind']): string {
  switch (kind) {
    case 'tool_result': return '工具返回记录'
    case 'settled_effect': return '已结算副作用'
    case 'file_state': return '文件状态'
    case 'command_result': return '命令结果'
    case 'requirement_check': return '要求检查'
    case 'vrs_verification': return '运行证据记录'
  }
}

function evidenceStatusLabel(status: TaskEvidenceReference['status']): string {
  switch (status) {
    case 'pass': return '通过'
    case 'fail': return '未通过'
    case 'partial': return '部分结果'
    case 'informational': return '事实记录'
  }
}

function artifactActionLabel(action: TaskOutcome['artifacts'][number]['action']): string {
  switch (action) {
    case 'created': return '本次创建'
    case 'modified': return '本次修改'
    case 'attached': return '已附加'
    case 'observed': return '已检查'
  }
}

function artifactVerificationDetail(
  artifact: TaskOutcome['artifacts'][number],
  evidence: TaskEvidenceReference[],
): string {
  if (artifact.verification === 'passed' || artifact.verification === 'failed') {
    const hash = evidence.find((item) => item.kind === 'file_state')?.contentHash
    return hash ? `检查时文件版本 ${hash.slice(0, 12)} · 后续变化未自动复核` : '检查时点结果'
  }
  return artifact.verification === 'unverified' ? '没有独立内容检查' : '检查受到阻断'
}

function safeReferenceSuffix(sourceRef: string): string | undefined {
  if (!/^[A-Za-z0-9_.:-]{1,192}$/u.test(sourceRef)) return undefined
  return sourceRef.length > 18 ? sourceRef.slice(-18) : sourceRef
}
