// Task composer controls, attachments, runtime selection, and sizing.
import { FloatingHelpTip,buildFloatingHelpTip,buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { compactPath } from '../workspace/path-utils'


export function WorkspaceChip({
  path,
  tip,
  onReset,
  onTipChange,
}: {
  path: string
  tip: string
  onReset: () => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const label = compactPath(path)

  return (
    <span
      className="workspace-context-chip"
      aria-label={`目标工作区: ${tip}`}
      onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
      onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
      onMouseLeave={() => onTipChange(null)}
      onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
      onBlur={() => onTipChange(null)}
    >
      <span className="workspace-context-label">工作区</span>
      <span className="workspace-context-path">{label}</span>
      <button
        className="workspace-context-remove"
        type="button"
        aria-label="移除目标工作区"
        onClick={() => {
          onTipChange(null)
          void onReset()
        }}
      >
        ×
      </button>
    </span>
  )
}
