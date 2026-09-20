// Approval UI and request types; authority remains in the main process.
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  type ApprovalRequest,
  type PermissionModeId
} from '../api'
import {
  type ApprovalDecision
} from '../approval-grants'
import { FadePresence } from '../ui/presence'
import { PendingApprovalPrompt } from './types'

export const APPROVAL_PROMPT_MOTION_MS = 220


export function ApprovalPrompt({
  prompt,
  onResolve,
}: {
  prompt: PendingApprovalPrompt | null
  onResolve: (decision: ApprovalDecision) => void
}) {
  const lastPromptRef = useRef<PendingApprovalPrompt | null>(prompt)
  if (prompt) lastPromptRef.current = prompt
  const displayedPrompt = prompt ?? lastPromptRef.current
  return createPortal(
    <FadePresence show={Boolean(prompt)} exitMs={APPROVAL_PROMPT_MOTION_MS} className="approval-presence">
      {displayedPrompt && (
        <ApprovalPromptSurface prompt={displayedPrompt} onResolve={onResolve} />
      )}
    </FadePresence>,
    document.body,
  )
}


export function ApprovalPromptSurface({
  prompt,
  onResolve,
}: {
  prompt: PendingApprovalPrompt
  onResolve: (decision: ApprovalDecision) => void
}) {
  const { request } = prompt
  const source = request.source ?? 'agent'
  return (
    <div
      className="approval-layer"
      role="presentation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onResolve('deny')
      }}
    >
      <section className="approval-prompt" role="dialog" aria-modal="true" aria-label="权限确认">
        <div className="approval-kicker">{source === 'workspace' ? '用户工作区操作' : 'Agent 工具调用'}</div>
        <h2>{approvalActionTitle(request.action)}</h2>
        <p>{approvalModeDescription(request.permissionMode)}</p>
        <p className="approval-boundary-note">{approvalBoundaryDescription(request.boundary)}</p>
        <p className="approval-risk-note">{approvalActionRiskDescription(request.action, source)}</p>
        <pre>{formatApprovalDetail(request.detail)}</pre>
        <p className="approval-session-note">“本对话允许”只授权当前对话中的同来源、同类操作；切换类别或重启应用后仍会重新询问。</p>
        <div className="approval-actions">
          <button type="button" className="approval-action" onClick={() => onResolve('deny')}>
            拒绝
          </button>
          <button type="button" className="approval-action session" onClick={() => onResolve('session')}>
            本对话允许
          </button>
          <button type="button" className="approval-action primary" autoFocus onClick={() => onResolve('once')}>
            仅本次
          </button>
        </div>
      </section>
    </div>
  )
}


export function approvalActionTitle(action: string): string {
  if (action === 'exec') return '允许执行命令？'
  if (action === 'write') return '允许写入文件？'
  if (action === 'edit') return '允许修改文件？'
  if (action === 'write_memory') return '允许写入长期记忆？'
  if (action === 'record_experience') return '允许记录经验？'
  if (action === 'save_file') return '允许保存工作区文件？'
  return `允许执行 ${action}？`
}


export function approvalModeDescription(mode: PermissionModeId): string {
  if (mode === 'restricted') return '当前为受限权限，所有工具操作都需要你批准，包括容器内查看。'
  if (mode === 'research') return '当前为研究权限，容器内读取可直接进行；修改、删除、执行和容器外访问需要你批准。'
  return '当前为完全访问权限。启用时已确认风险，普通工具操作不再逐次请求批准。'
}


export function approvalBoundaryDescription(boundary: ApprovalRequest['boundary']): string {
  if (boundary === 'outside') return '范围判定：容器外资源。此次操作必须由你明确批准。'
  if (boundary === 'unknown') return '范围判定：无法证明留在容器内。此次操作按高风险处理并要求批准。'
  if (boundary === 'inside') return '范围判定：LS 容器内资源。'
  return '范围判定：由当前操作详情进一步确认。'
}


export function approvalActionRiskDescription(action: string, source: 'agent' | 'workspace'): string {
  const actor = source === 'workspace' ? '你在拓展工作区发起的操作' : 'Agent 为完成当前任务发起的操作'
  if (action === 'exec') return `${actor}将执行命令，可能修改工作区文件或启动本地进程。`
  if (action === 'write' || action === 'edit' || action === 'save_file') {
    return `${actor}将修改所示文件；请确认目标路径和变更范围。`
  }
  return `${actor}需要临时使用这项工具能力。`
}


export function formatApprovalDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return '无额外参数'
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail, null, 2)
  } catch {
    return String(detail)
  }
}
