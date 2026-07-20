// Settings navigation and page composition.
import { useRef } from 'react'
import {
  type AgentProfileId,
  type RuntimeState
} from '../api'
import { isDirectModulePage } from '../app-shell/navigation'
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from '../app-shell/preferences'
import { ArchiveManager } from '../ArchiveManager'
import { ChannelConnections } from '../ChannelConnections'
import { MemorySkills } from '../MemorySkills'
import { Settings } from '../Settings'
import { GlobalTitlebar } from '../sidebar/global-titlebar'
import { FloatingHelpTip } from '../ui/floating-help'
import { SettingsGearIcon } from '../ui/icons'
import { SettingsAgentProfilePage } from './agent-profile'
import { DirectModulePageContent } from './direct-module'
import { SettingsHome } from './home'
import { SETTINGS_NAV_GROUPS } from './navigation'
import { SettingsStoragePage } from './storage'
import { SettingsBrowserPage } from './browser'
import { SettingsDevelopmentEnvironmentsPage } from './development-environments'
import { SettingsPage } from './types'


export function SettingsWorkspace({
  page,
  runtime,
  sidebarCollapsed,
  sidebarWidth,
  sidebarToggleTip,
  canBack,
  canForward,
  onBeginSidebarResize,
  onNudgeSidebar,
  onSetSidebarWidth,
  onToggleSidebar,
  onBack,
  onForward,
  onClose,
  settingsEntryRippling,
  onOpenPage,
  onProfileChange,
  onContextCompressionThresholdChange,
  onArchiveChanged,
  onTipChange,
}: {
  page: SettingsPage
  runtime: RuntimeState | null
  sidebarCollapsed: boolean
  sidebarWidth: number
  sidebarToggleTip: string
  canBack: boolean
  canForward: boolean
  onBeginSidebarResize: (event: React.PointerEvent<HTMLDivElement>) => void
  onNudgeSidebar: (delta: number) => void
  onSetSidebarWidth: (width: number) => void
  onToggleSidebar: () => void
  onBack: () => void
  onForward: () => void
  onClose: () => void
  settingsEntryRippling: boolean
  onOpenPage: (page: SettingsPage) => void
  onProfileChange: (profile: AgentProfileId) => void
  onContextCompressionThresholdChange: (ratio: number) => Promise<void>
  onArchiveChanged: () => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const returnHome = () => onOpenPage('home')
  const initialPageRef = useRef(page)
  const pageHasChangedRef = useRef(false)

  if (page !== initialPageRef.current) {
    pageHasChangedRef.current = true
  }

  return (
    <div className="settings-workspace">
      <GlobalTitlebar
        sidebarCollapsed={sidebarCollapsed}
        sidebarToggleTip={sidebarToggleTip}
        canNavigateBack={canBack}
        canNavigateForward={canForward}
        onToggleSidebar={onToggleSidebar}
        onBack={onBack}
        onForward={onForward}
        onTipChange={onTipChange}
      />
      <div className="settings-layout">
        <aside className="settings-sidebar" aria-hidden={sidebarCollapsed} {...(sidebarCollapsed ? { inert: '' } : {})}>
          <div className="settings-sidebar-contents">
            <div className="brand-block">
              <div className="brand-title">设置</div>
              <div className="brand-subtitle">系统能力与本地工作台</div>
            </div>
            <section className="settings-nav-section" aria-label="设置分组">
              {SETTINGS_NAV_GROUPS.map((group) => (
                <div key={group.title} className="settings-nav-group">
                  <div className="settings-nav-group-title">{group.title}</div>
                  <div className="settings-nav-group-items">
                    {group.items.map((item) => (
                      <button
                        key={item.page}
                        className={`settings-nav-item ${page === item.page ? 'active' : ''}`}
                        type="button"
                        aria-current={page === item.page ? 'page' : undefined}
                        onClick={() => onOpenPage(item.page)}
                      >
                        <span>
                          <strong>{item.title}</strong>
                          <small>{item.desc}</small>
                        </span>
                        <span className="settings-nav-arrow" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
            <div className="sidebar-footer settings-sidebar-footer">
              <button
                className={`settings-entry-btn active ${settingsEntryRippling ? 'rippling' : ''}`}
                type="button"
                onClick={onClose}
                aria-label="关闭设置"
                aria-expanded="true"
              >
                <SettingsGearIcon />
                <span className="settings-entry-label">设置</span>
              </button>
            </div>
          </div>
        </aside>
        <div
          className="settings-sidebar-resizer"
          role="separator"
          aria-hidden={sidebarCollapsed}
          {...(sidebarCollapsed ? { inert: '' } : {})}
          aria-label="调整设置侧栏宽度"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={sidebarCollapsed ? -1 : 0}
          onPointerDown={onBeginSidebarResize}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              onNudgeSidebar(event.shiftKey ? -32 : -12)
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              onNudgeSidebar(event.shiftKey ? 32 : 12)
            } else if (event.key === 'Home') {
              event.preventDefault()
              onSetSidebarWidth(SIDEBAR_WIDTH_MIN)
            } else if (event.key === 'End') {
              event.preventDefault()
              onSetSidebarWidth(SIDEBAR_WIDTH_MAX)
            }
          }}
        />
        <main className="settings-workspace-body">
          <div key={page} className={`settings-page-transition ${pageHasChangedRef.current ? 'with-motion' : ''}`}>
            {page === 'home' && <SettingsHome onOpenPage={onOpenPage} />}
            {page === 'agent' && (
              <SettingsAgentProfilePage
                profile={runtime?.profile ?? 'general'}
                contextCompressionThresholdRatio={runtime?.contextCompressionThresholdRatio ?? 0.8}
                onChange={onProfileChange}
                onContextCompressionThresholdChange={onContextCompressionThresholdChange}
              />
            )}
            {page === 'api' && <Settings onClose={returnHome} embedded />}
            {page === 'storage' && <SettingsStoragePage />}
            {page === 'browser' && <SettingsBrowserPage />}
            {page === 'developmentEnvironments' && <SettingsDevelopmentEnvironmentsPage />}
            {page === 'channels' && <ChannelConnections onClose={returnHome} embedded />}
            {page === 'archive' && <ArchiveManager onChanged={onArchiveChanged} />}
            {isDirectModulePage(page) && <DirectModulePageContent page={page} />}
            {page === 'skills' && <MemorySkills onClose={returnHome} embedded />}
          </div>
        </main>
      </div>
    </div>
  )
}
