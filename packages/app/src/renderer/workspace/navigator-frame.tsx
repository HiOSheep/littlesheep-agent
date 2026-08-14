// Shared right-side navigator shell for directory browsing and Git review.
import type { ReactNode } from 'react'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FolderGlyphIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'

export function WorkspaceNavigatorFrame({
  collapsed,
  ariaLabel,
  children,
  onCollapsedChange,
  onTipChange,
}: {
  collapsed: boolean
  ariaLabel: string
  children: ReactNode
  onCollapsedChange: (collapsed: boolean) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const toggleLabel = collapsed ? `展开${ariaLabel}` : `折叠${ariaLabel}`

  return (
    <aside
      className={`workspace-files-navigator ${collapsed ? 'navigator-collapsed' : ''}`}
      aria-label={ariaLabel}
      aria-expanded={!collapsed}
    >
      <button
        {...transientTriggerProps()}
        className="workspace-files-navigator-rail"
        type="button"
        aria-label={toggleLabel}
        aria-expanded={!collapsed}
        onClick={() => onCollapsedChange(!collapsed)}
        onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(toggleLabel, event.clientX, event.clientY))}
        onMouseMove={(event) => onTipChange(buildFloatingHelpTip(toggleLabel, event.clientX, event.clientY))}
        onMouseLeave={() => onTipChange(null)}
        onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(toggleLabel, event.currentTarget))}
        onBlur={() => onTipChange(null)}
      >
        <FolderGlyphIcon />
      </button>
      <div
        className="workspace-files-navigator-inner"
        aria-hidden={collapsed}
        {...(collapsed ? { inert: '' } : {})}
      >
        {children}
      </div>
    </aside>
  )
}
