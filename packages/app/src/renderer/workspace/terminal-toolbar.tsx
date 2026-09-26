// UX-29: the terminal's toolbar.
//
// Extracted from the terminal surface because the surface is a composition hotspot with a
// ceiling, and because the labels here have to follow the *running* shell: a session started
// with Git Bash must not be described as PowerShell in its own controls.
import type { FloatingHelpTip } from '../ui/floating-help'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { transientTriggerProps } from '../ui/transient'

export function WorkspaceTerminalToolbar({
  shellLabel,
  backend,
  sessionCount,
  onNew,
  onInterrupt,
  onRestart,
  onClear,
  onTipChange,
}: {
  /** The shell this session is really running, used in every label below. */
  shellLabel: string
  backend: 'pty' | 'spawn' | ''
  /** How many sessions are open, so the wording can say what a command affects. */
  sessionCount: number
  onNew: () => void
  onInterrupt: () => void
  onRestart: () => void
  onClear: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const scope = sessionCount > 1 ? `（只影响这一个，共 ${sessionCount} 个终端）` : ''
  const buttons: Array<{ label: string; tip: string; onClick: () => void }> = [
    // A second session is a new terminal beside the running one, which is why this is first:
    // it never replaces what is already there (UX-30).
    { label: '新建', tip: '新建一个终端会话；正在运行的终端不受影响', onClick: onNew },
    {
      label: '中断',
      tip: backend === 'pty'
        ? `向当前 ${shellLabel} 终端发送 Ctrl+C${scope}`
        : `强制停止当前 ${shellLabel} 进程树；兼容模式不发送 Ctrl+C${scope}`,
      onClick: onInterrupt,
    },
    { label: '重启', tip: `停止当前 ${shellLabel} 会话并重新启动${scope}`, onClick: onRestart },
    { label: '清空', tip: `清空当前终端的显示输出${scope}`, onClick: onClear },
  ]

  return (
    <>
      {buttons.map((button) => (
        <button
          key={button.label}
          {...transientTriggerProps()}
          className="workspace-files-text-btn"
          type="button"
          onClick={button.onClick}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(button.tip, event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(button.tip, event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(button.tip, event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          {button.label}
        </button>
      ))}
    </>
  )
}
