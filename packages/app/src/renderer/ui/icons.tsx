// Reusable renderer interaction primitives and icons.
import { ModeRisk } from '../runtime/options'
import {
  type WorkspacePanelTab
} from '../workspace-persistence'

export function SidebarToggleIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={['sidebar-toggle-icon', className].filter(Boolean).join(' ')} viewBox="0 0 18 14" aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <rect className="sidebar-toggle-outline" x="0.5" y="0.5" width="17" height="13" rx="3" /><path className="sidebar-toggle-divider" d="M9.5 3v8" />
    </svg>
  )
}

export function SettingsGearIcon() {
  return (
    <svg className="settings-gear-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function NavComposeIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.4 12.6h2.4l6.45-6.45a1.7 1.7 0 0 0-2.4-2.4L3.4 10.2v2.4zM9.05 4.55l2.4 2.4" />
    </svg>
  )
}

export function SearchIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7.1" cy="7.1" r="4.25" />
      <path d="M10.25 10.25l2.8 2.8" />
    </svg>
  )
}


export function ScheduleIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.35" />
      <path d="M8 4.65v3.55l2.35 1.35" />
    </svg>
  )
}


export function MemoryTreeNavIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="3.35" r="1.35" />
      <circle cx="4.45" cy="11.85" r="1.35" />
      <circle cx="11.55" cy="11.85" r="1.35" />
      <path d="M8 4.75v2.25M8 7l-3.05 3.65M8 7l3.05 3.65" />
    </svg>
  )
}


export function PluginIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6.15 2.8v3.35M9.85 2.8v3.35M5.2 6.15h5.6v2.9a2.8 2.8 0 0 1-5.6 0v-2.9zM8 11.85v1.35" />
    </svg>
  )
}


export function ProjectIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 4.45h3.2l1.05 1.25H13v5.85H3z" />
    </svg>
  )
}


export function CloseIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />
    </svg>
  )
}


export function MoreIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="4" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12" cy="8" r="1.25" />
    </svg>
  )
}


export function ComposeIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="3.25" y="3.25" width="9.5" height="9.5" rx="2.1" />
      <path d="M8 5.15v5.7M5.15 8h5.7" />
    </svg>
  )
}


export function PinIcon({ active }: { active: boolean }) {
  return (
    <svg className={`sidebar-svg-icon pin-icon ${active ? 'active' : ''}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {active ? (
        <path className="pin-icon-solid" d="M5.2 2.3h5.6l-.65 4.55 2.05 2.2v1.25H8.7v3.45H7.3V10.3H3.8V9.05l2.05-2.2z" />
      ) : (
        <path d="M5.15 2.75h5.7M6.25 3.1l.5 4.15-2 2.2v1.05h6.5V9.45l-2-2.2.5-4.15M8 10.5v3" />
      )}
    </svg>
  )
}


export function RenameIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m3.15 11.85.55-2.7 6.8-6.8 2.15 2.15-6.8 6.8zM9.4 3.45l2.15 2.15M3.1 13h9.8" />
    </svg>
  )
}


export function CheckIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 8.25l2.75 2.75 6.25-6.5" />
    </svg>
  )
}


export function SortIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.1 4.2h7.8M4.1 8h5.7M4.1 11.8h3.2" />
    </svg>
  )
}


export function ArchiveIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 5.3h10M4.05 5.3v7.05h7.9V5.3M3.55 2.9h8.9l.55 2.4H3zM6.45 8.2h3.1" />
    </svg>
  )
}


export function TrashIcon() {
  return (
    <svg className="sidebar-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.4 4.45h9.2M6.35 4.45V3.1h3.3v1.35M4.65 4.45l.55 8.15h5.6l.55-8.15M6.8 6.8v3.65M9.2 6.8v3.65" />
    </svg>
  )
}


export function WorkspaceFeatureIcon({ id }: { id: WorkspacePanelTab }) {
  if (id === 'review') {
    return (
      <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="3.05" y="2.75" width="9.9" height="10.5" rx="2.1" />
        <path d="M5.55 6.15h4.9M5.55 8h4.9M5.55 9.85h2.7" />
        <path d="M8 1.95v2.1M6.95 3h2.1" />
      </svg>
    )
  }
  if (id === 'terminal') {
    return (
      <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="2.65" y="3.25" width="10.7" height="9.5" rx="2.1" />
        <path d="M5.05 6.4 6.65 8l-1.6 1.6M7.8 9.6h3.1" />
      </svg>
    )
  }
  if (id === 'artifacts') {
    return (
      <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.05 3.15h5.25l2.65 2.65v6.95h-7.9z" />
        <path d="M9.15 3.35v2.65h2.65M6 8.1h4M6 10.05h3" />
        <path d="M2.85 4.95v8.1h7.1" />
      </svg>
    )
  }
  if (id === 'browser') {
    return (
      <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="5.25" />
        <path d="M2.9 8h10.2M8 2.75c1.35 1.4 2 3.15 2 5.25s-.65 3.85-2 5.25M8 2.75C6.65 4.15 6 5.9 6 8s.65 3.85 2 5.25" />
      </svg>
    )
  }
  if (id === 'sideChat') {
    return (
      <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3.1 4.15h9.8v6.1H7.55l-2.65 2.1v-2.1H3.1z" />
        <path d="M5.35 6.45h5.3M5.35 8.15h3.4" />
      </svg>
    )
  }
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 4.25h3.2l1.05 1.25H13v6.25H3z" />
    </svg>
  )
}


export function CloseMiniIcon() {
  return (
    <svg className="workspace-panel-svg-icon close-mini-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.25 5.25 10.75 10.75M10.75 5.25 5.25 10.75" />
    </svg>
  )
}


export function WorkspacePanelIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2.4" y="2.65" width="11.2" height="10.7" rx="2.1" />
      <path d="M9.75 2.9v10.2" />
      <path className="workspace-panel-icon-arrow" d={collapsed ? 'M5.45 5.35 7.95 8l-2.5 2.65' : 'M7.95 5.35 5.45 8l2.5 2.65'} />
    </svg>
  )
}


export function SendRunIcon() {
  return (
    <svg className="send-round-icon send" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />
    </svg>
  )
}


export function StopRunIcon() {
  return (
    <svg className="send-round-icon stop" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="5" y="5" width="6" height="6" rx="1" />
    </svg>
  )
}


export function PanelFullscreenIcon({ active }: { active: boolean }) {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {active ? (
        <path d="M6.7 3.2H3.25v3.45M9.3 3.2h3.45v3.45M6.7 12.8H3.25V9.35M9.3 12.8h3.45V9.35M5.15 5.15l-1.9-1.9M10.85 5.15l1.9-1.9M5.15 10.85l-1.9 1.9M10.85 10.85l1.9 1.9" />
      ) : (
        <path d="M3.45 6.45v-3h3M9.55 3.45h3v3M12.55 9.55v3h-3M6.45 12.55h-3v-3M3.45 3.45l3 3M12.55 3.45l-3 3M12.55 12.55l-3-3M3.45 12.55l3-3" />
      )}
    </svg>
  )
}


export function PanelCollapseIcon() {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M10.1 4.35 6.45 8l3.65 3.65" />
    </svg>
  )
}


export function RefreshIcon() {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M12.7 6.05A4.65 4.65 0 1 0 13 8M12.85 3.75v2.4h-2.4" />
    </svg>
  )
}


export function ExternalOpenIcon() {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6.6 3.45H3.5v9.05h9.05V9.4M8.25 3.45h4.3v4.3M12.35 3.65 7.35 8.65" />
    </svg>
  )
}


export function VSCodeIcon() {
  return (
    <svg className="workspace-panel-svg-icon vscode-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M11.95 2.9 6.35 8l5.6 5.1 1.65-.75V3.65z" />
      <path d="M6.35 5.4 3.9 3.6 2.45 4.35 4.85 8l-2.4 3.65 1.45.75 2.45-1.8" />
    </svg>
  )
}


export function TreeChevronIcon() {
  return (
    <svg className="workspace-tree-chevron-icon" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M4.4 2.9 7.55 6 4.4 9.1" />
    </svg>
  )
}


export function FolderGlyphIcon() {
  return (
    <svg className="workspace-tree-glyph-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.4 4.25h4l1.05 1.3h6.15v6.2H2.4z" />
    </svg>
  )
}


export function FileGlyphIcon() {
  return (
    <svg className="workspace-tree-glyph-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.15 2.65h5.4l2.3 2.3v8.4h-7.7zM9.4 2.9v2.25h2.2" />
    </svg>
  )
}


export function ModeRiskIcon({ risk, className }: { risk: ModeRisk; className: string }) {
  const isWarning = risk === 'critical' || risk === 'high'
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle className="mode-risk-ring" cx="8" cy="8" r="7" />
      {isWarning ? (
        <>
          <rect className="mode-risk-stem" x="6.75" y="3" width="2.5" height="7.5" rx="1.25" />
          <circle className="mode-risk-dot" cx="8" cy="12.25" r="1.35" />
        </>
      ) : (
        <circle className="mode-risk-dot" cx="8" cy="8" r="1.8" />
      )}
    </svg>
  )
}
