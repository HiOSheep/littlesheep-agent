// Primary navigation, project/session trees, and sidebar actions.
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { SettingsGearIcon } from '../ui/icons'
import appIconUrl from '../../../resources/littlesheep-icon.png'


export function GlobalTitlebar({
  sidebarCollapsed,
  sidebarToggleTip,
  canNavigateBack,
  canNavigateForward,
  onToggleSidebar,
  onBack,
  onForward,
  onTipChange,
}: {
  sidebarCollapsed: boolean
  sidebarToggleTip: string
  canNavigateBack: boolean
  canNavigateForward: boolean
  onToggleSidebar: () => void
  onBack: () => void
  onForward: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <header className="window-titlebar" aria-label="LittleSheep titlebar">
      <div className="app-nav-controls" aria-label="全局导航">
        <button
          className="sidebar-toggle-btn"
          type="button"
          aria-label={sidebarToggleTip}
          aria-expanded={!sidebarCollapsed}
          onClick={onToggleSidebar}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(sidebarToggleTip, event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(sidebarToggleTip, event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(sidebarToggleTip, event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <span className="sidebar-toggle-icon" aria-hidden="true">
            <span className="sidebar-toggle-divider" />
          </span>
        </button>
        <button
          className="app-nav-btn nav-back"
          type="button"
          disabled={!canNavigateBack}
          onClick={onBack}
          aria-label="返回"
        >
          ←
        </button>
        <button
          className="app-nav-btn nav-forward"
          type="button"
          disabled={!canNavigateForward}
          onClick={onForward}
          aria-label="前进"
        >
          →
        </button>
      </div>
      <div className="window-titlebar-brand">
        <img className="window-titlebar-icon" src={appIconUrl} alt="" aria-hidden="true" />
        <span>LittleSheep</span>
      </div>
    </header>
  )
}


export function SettingsEntryBridge({
  settingsOpen,
  onOpen,
  onClose,
  rippling,
}: {
  settingsOpen: boolean
  onOpen: () => void
  onClose: () => void
  rippling: boolean
}) {
  return (
    <button
      className={`settings-entry-bridge ${rippling ? 'rippling' : ''}`}
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={settingsOpen ? onClose : onOpen}
    >
      <SettingsGearIcon />
      <span className="settings-entry-bridge-label">设置</span>
    </button>
  )
}
