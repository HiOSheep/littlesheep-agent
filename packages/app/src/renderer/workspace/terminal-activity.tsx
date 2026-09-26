// UX-29: the recent-command list beside the terminal.
//
// Extracted from the terminal surface (a composition hotspot with a ceiling). The list only
// inserts a command into the input — it never runs anything on its own, which is why the rows
// are plain buttons that call back with the command text.
import type { TerminalActivityRecord } from '../../shared/workspace-contracts'
import type { FloatingHelpTip } from '../ui/floating-help'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { RefreshIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'

export interface WorkspaceTerminalActivityListProps {
  activities: readonly TerminalActivityRecord[]
  activityError: string
  onInsertCommand: (command: string) => void
  onRefresh: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}

export function WorkspaceTerminalActivityList({
  activities,
  activityError,
  onInsertCommand,
  onRefresh,
  onTipChange,
}: WorkspaceTerminalActivityListProps) {
  return (
    <div className="workspace-terminal-activity" aria-label="最近终端命令">
      <div className="workspace-terminal-activity-heading">
        <span>最近命令</span>
        <button
          {...transientTriggerProps()}
          className="workspace-terminal-activity-refresh"
          type="button"
          onClick={onRefresh}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新最近命令', event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新最近命令', event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新最近命令', event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <RefreshIcon />
        </button>
      </div>
      <div className="workspace-terminal-activity-list">
        {activities.length === 0 && !activityError && (
          <span className="workspace-terminal-activity-empty">暂无命令记录</span>
        )}
        {activityError && <span className="workspace-terminal-activity-empty error">{activityError}</span>}
        {activities.map((activity) => {
          const tip = terminalActivityTip(activity)
          return (
            <button
              key={activity.id}
              type="button"
              className={`workspace-terminal-activity-row ${activity.exitCode === 0 && !activity.timedOut ? 'ok' : 'failed'}`}
              // Inserting only: the user decides when to run it.
              onClick={() => onInsertCommand(activity.command)}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <span className="workspace-terminal-activity-command">{activity.command}</span>
              <span className="workspace-terminal-activity-meta">
                {terminalActivityStatus(activity)} · {formatDurationMs(activity.durationMs)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function terminalActivityStatus(activity: TerminalActivityRecord): string {
  if (activity.signal === 'session') return '已发送'
  if (activity.signal === 'captured' || activity.signal === 'next-command') return '已记录'
  if (activity.signal === 'interrupt') return '已中断'
  if (activity.signal === 'closed') return '已关闭'
  if (activity.signal === 'send-failed') return '发送失败'
  if (activity.timedOut) return '超时'
  if (activity.exitCode === 0) return '成功'
  return `退出 ${activity.exitCode ?? activity.signal ?? '异常'}`
}

export function terminalActivityTip(activity: TerminalActivityRecord): string {
  const parts = [
    activity.command,
    `cwd: ${activity.cwd}`,
    `${terminalActivityStatus(activity)} · ${formatDurationMs(activity.durationMs)}`,
  ]
  if (activity.stdoutPreview) parts.push(`stdout: ${activity.stdoutPreview.slice(0, 240)}`)
  if (activity.stderrPreview) parts.push(`stderr: ${activity.stderrPreview.slice(0, 240)}`)
  return parts.join('\n')
}

export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0ms'
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${Math.floor(durationMs / 60_000)}m${Math.round((durationMs % 60_000) / 1000)}s`
}
