// Primary navigation, project/session trees, and sidebar actions.
import { type ReactNode } from 'react'
import { SidebarPanel } from '../app-shell/types'
import { DirectModulePage } from '../settings/types'
import { buildFloatingHelpTip,buildFloatingHelpTipFromElement,FloatingHelpTip } from '../ui/floating-help'
import { MemoryTreeNavIcon,NavComposeIcon,PluginIcon,ScheduleIcon,SearchIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'


export function SidebarQuickNav({
  activePanel,
  activeModule,
  onNewConversation,
  onOpenPanel,
  onOpenModulePage,
  onTipChange,
}: {
  activePanel: SidebarPanel
  activeModule: DirectModulePage | null
  onNewConversation: () => void
  onOpenPanel: (panel: NonNullable<SidebarPanel>) => void
  onOpenModulePage: (page: DirectModulePage) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <nav className="sidebar-quick-nav" aria-label="基础功能">
      <SidebarNavButton
        label="新对话"
        icon={<NavComposeIcon />}
        onClick={onNewConversation}
        onTipChange={onTipChange}
      />
      <SidebarNavButton
        label="搜索"
        icon={<SearchIcon />}
        active={activePanel === 'search'}
        onClick={() => onOpenPanel('search')}
        onTipChange={onTipChange}
      />
      <SidebarNavButton
        label="记忆树"
        icon={<MemoryTreeNavIcon />}
        active={activeModule === 'memoryTree'}
        onClick={() => onOpenModulePage('memoryTree')}
        onTipChange={onTipChange}
      />
      <SidebarNavButton
        label="已安排"
        icon={<ScheduleIcon />}
        active={activeModule === 'scheduled'}
        onClick={() => onOpenModulePage('scheduled')}
        onTipChange={onTipChange}
      />
      <SidebarNavButton
        label="插件"
        icon={<PluginIcon />}
        active={activeModule === 'plugins'}
        onClick={() => onOpenModulePage('plugins')}
        onTipChange={onTipChange}
      />
    </nav>
  )
}


export function SidebarNavButton({
  label,
  icon,
  active = false,
  onClick,
  onTipChange,
}: {
  label: string
  icon: ReactNode
  active?: boolean
  onClick: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <button
      {...transientTriggerProps()}
      className={`sidebar-nav-button ${active ? 'active' : ''}`}
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={() => {
        onTipChange(null)
        onClick()
      }}
      onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY))}
      onMouseMove={(event) => onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY))}
      onMouseLeave={() => onTipChange(null)}
      onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(label, event.currentTarget))}
      onBlur={() => onTipChange(null)}
    >
      <span className="sidebar-nav-icon" aria-hidden="true">{icon}</span>
      <span className="sidebar-nav-label">{label}</span>
    </button>
  )
}
