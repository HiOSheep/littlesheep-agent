// Approval UI and request types; authority remains in the main process.
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  type ApprovalRequest,
  type PermissionModeId
} from '../api'
import { isPerCallApprovalRequest, type ApprovalDecision } from '../approval-grants'
import { FadePresence } from '../ui/presence'
import { useModalSurface } from '../ui/modal-surface'
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
  const lastInlineTargetRef = useRef<Element | null>(null)
  if (prompt) lastPromptRef.current = prompt
  const displayedPrompt = prompt ?? lastPromptRef.current
  const nextInlineTarget = (displayedPrompt?.request.source ?? 'agent') === 'agent'
    ? document.querySelector('.assistant-turn.running .assistant-approval-seat') : null
  if (prompt) lastInlineTargetRef.current = nextInlineTarget
  const inlineTarget = prompt ? nextInlineTarget : lastInlineTargetRef.current?.isConnected ? lastInlineTargetRef.current : null
  return createPortal(
    <FadePresence show={Boolean(prompt)} exitMs={APPROVAL_PROMPT_MOTION_MS} className={`approval-presence${inlineTarget ? ' approval-presence-inline' : ''}`}>
      {displayedPrompt && (
        <ApprovalPromptSurface
          prompt={displayedPrompt}
          active={Boolean(prompt)}
          inline={Boolean(inlineTarget)}
          onResolve={onResolve}
        />
      )}
    </FadePresence>,
    inlineTarget ?? document.body,
  )
}


export function ApprovalPromptSurface({
  prompt,
  active = true,
  inline = false,
  onResolve,
}: {
  prompt: PendingApprovalPrompt
  /** False while the prompt only animates out; it must not take keys then. */
  active?: boolean
  inline?: boolean
  onResolve: (decision: ApprovalDecision) => void
}) {
  const { request } = prompt
  const source = request.source ?? 'agent'
  const perCallApproval = isPerCallApprovalRequest(request)
  const dialogRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Escape keeps its rejection meaning. The dialog itself takes the initial
  // focus, so a held Enter cannot authorize anything: granting still requires
  // moving to a specific action button.
  useModalSurface(dialogRef, {
    active: active && !inline,
    onEscape: () => onResolve('deny'),
    initialFocusRef: headingRef,
  })
  return (
    <div className={`approval-layer${inline ? ' approval-inline' : ''}`} role="presentation">
      <section
        ref={dialogRef}
        className="approval-prompt"
        role={inline ? 'region' : 'dialog'}
        aria-modal={inline ? undefined : true}
        aria-label="权限确认"
        tabIndex={-1}
        onKeyDown={inline ? (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); onResolve('deny') }
        } : undefined}
      >
        <div className="approval-kicker">{source === 'workspace' ? '用户工作区操作' : 'Agent 工具调用'}</div>
        <h2 ref={headingRef} tabIndex={-1}>{approvalActionTitle(request.action)}</h2>
        <p>{approvalModeDescription(request.permissionMode, request.permissionPreset)}</p>
        <p className="approval-boundary-note">{approvalBoundaryDescription(request.boundary, request.permissionPreset)}</p>
        <p className="approval-risk-note">{approvalActionRiskDescription(request.action, source)}</p>
        {request.shellBatch ? <div className="approval-shell-batch">
          <p>对话：{request.shellBatch.commands[0]?.sessionId} · 运行：{request.shellBatch.commands[0]?.runId}</p>
          {request.shellBatch.commands.map((command, index) => <section key={command.invocationId} className="approval-shell-command">
            <strong>命令 {index + 1} / {request.shellBatch!.commands.length}</strong>
            <pre>{command.command}</pre>
            <dl>
              <dt>Shell</dt><dd>{command.shell.path} {command.shell.args.join(' ')}</dd>
              <dt>工作目录</dt><dd>{command.cwd.path}</dd>
              <dt>工作区</dt><dd>{command.workspace.path}</dd>
              <dt>执行身份</dt><dd>当前宿主用户：{command.user}</dd>
              <dt>执行上限</dt><dd>{command.timeoutMs / 1000} 秒</dd>
            </dl>
          </section>)}
          <p>{request.rememberShellCommandAvailable
            ? '该命令默认仅批准本次。只有你主动选择下方选项，Main 才会在本对话记住这条精确命令；最多再匹配 20 次或 30 分钟，以先到者为准。'
            : `仅限以上已列出的调用，每条只能执行一次；批次结束或取消立即失效，最迟于 ${new Date(request.shellBatch.expiresAt).toLocaleTimeString()} 失效。后续命令仍需确认。`}</p>
        </div> : <pre>{formatApprovalDetail(request.detail)}</pre>}
        <p className="approval-session-note">{request.rememberShellCommandAvailable
          ? 'Shell 仍以当前宿主用户权限运行，没有 OS 级沙箱；工作区外文件、网络和子进程风险仍然存在。授权只适用于当前对话和绑定的工作区与执行环境。'
          : perCallApproval
            ? '此操作需要单独确认；授权仅作用于本次请求。'
          : '“本对话允许”只授权当前对话中的同来源、同类操作；切换类别或重启应用后仍会重新询问。'}</p>
        <div className="approval-actions">
          <button type="button" className="approval-action" onClick={() => onResolve('deny')}>
            {request.shellBatch?.scope === 'batch' ? '拒绝整个批次' : '拒绝'}
          </button>
          {!perCallApproval && (
            <button type="button" className="approval-action session" onClick={() => onResolve('session')}>
              本对话允许
            </button>
          )}
          {request.rememberShellCommandAvailable && (
            <button type="button" className="approval-action session" onClick={() => onResolve('remember-shell')}>
              本对话允许这条命令
            </button>
          )}
          <button type="button" className="approval-action primary" onClick={() => onResolve('once')}>
            {request.shellBatch?.scope === 'batch' ? '批准以上全部命令' : '仅本次'}
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


export function approvalModeDescription(mode: PermissionModeId, preset?: ApprovalRequest['permissionPreset']): string {
  if (preset === 'read-only') return '当前为只读授权；工作区内可安全读取，写入需要明确升级权限。'
  if (preset === 'workspace-write') return '当前为工作区写入授权；普通文件操作仅在工作区约束有效时自动执行，Shell 与插件操作仍需确认。'
  if (preset === 'full-access') return '当前为完全访问授权；本次操作仍需要你明确确认。'
  if (mode === 'restricted') return '当前策略要求每次工具操作都获得明确批准。'
  if (mode === 'research') return '当前操作需要额外授权；请核对目标路径或命令。'
  return '当前操作按旧版兼容策略处理；本次仍需核对授权范围。'
}


export function approvalBoundaryDescription(boundary: ApprovalRequest['boundary'], preset?: ApprovalRequest['permissionPreset']): string {
  if (preset) {
    if (boundary === 'unknown') return '此工具的访问范围无法由工作区文件约束保证，需要你确认。'
    // The legacy boundary is measured against dataRoot, not workspaceRoot.
    // Never label a user workspace as "outside" from this field alone.
    return '本次调用需要额外授权；请核对下面的目标路径或命令。'
  }
  if (boundary === 'outside') return '范围判定：容器外资源。此次操作必须由你明确批准。'
  if (boundary === 'unknown') return '范围判定：无法证明留在容器内。此次操作按高风险处理并要求批准。'
  if (boundary === 'inside') return '范围判定：LS 容器内资源。'
  return '范围判定：由当前操作详情进一步确认。'
}


export function approvalActionRiskDescription(action: string, source: 'agent' | 'workspace'): string {
  const actor = source === 'workspace' ? '你在拓展工作区发起的操作' : 'Agent 为完成当前任务发起的操作'
  if (action === 'exec') {
    if (source === 'workspace') {
      return `${actor}将执行命令。该命令会在你的交互式终端中以当前用户权限运行；LS 不会为该终端命令提供操作系统级沙箱，其可访问范围由命令和用户账户权限决定。`
    }
    return `${actor}将执行命令。命令会在当前用户的宿主环境运行；LS 当前没有为 Agent Shell 提供操作系统级沙箱，工作区边界不会限制该命令。它可能访问此用户可访问的其他文件、启动本地进程或使用网络。`
  }
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
