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
  onInterrupt,
  onRestart,
  onClear,
  onTipChange,
}: {
  /** The shell this session is really running, used in every label below. */
  shellLabel: string
  onInterrupt: () => void
  onRestart: () => void
  onClear: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const buttons: Array<{ label: string; tip: string; onClick: () => void }> = [
    { label: '中断', tip: `向当前 ${shellLabel} 终端发送 Ctrl+C`, onClick: onInterrupt },
    { label: '重启', tip: `停止当前 ${shellLabel} 会话并重启`, onClick: onRestart },
    { label: '清空', tip: '清空终端输出', onClick: onClear },
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
