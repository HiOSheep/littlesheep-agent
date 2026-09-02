// Settings navigation and page composition.
import { useRef, useState } from 'react'
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
import { SettingsAgentProfilePage } from './agent-profile'
import { SettingsApplicationBackgroundPage } from './application-background'
import { DirectModulePageContent } from './direct-module'
import { SettingsHome } from './home'
import { SETTINGS_NAV_GROUPS } from './navigation'
import { SettingsStoragePage } from './storage'
import { SettingsBrowserPage } from './browser'
import { SettingsDevelopmentEnvironmentsPage } from './development-environments'
import { SettingsWebPage } from './web'
import { SettingsPage } from './types'
import { CloseIcon, SearchIcon, SettingsNavArrowIcon } from '../ui/icons'


export function SettingsWorkspace({
  page,
  runtime,
  sidebarCollapsed,
  sidebarWidth,
  onBeginSidebarResize,
  onNudgeSidebar,
  onSetSidebarWidth,
  onOpenPage,
  onCloseSettings,
  onProfileChange,
  onContextCompressionThresholdChange,
  onClosePolicyChange,
  onArchiveChanged,
}: {
  page: SettingsPage
  runtime: RuntimeState | null
  sidebarCollapsed: boolean
  sidebarWidth: number
  onBeginSidebarResize: (event: React.PointerEvent<HTMLDivElement>) => void
  onNudgeSidebar: (delta: number) => void
  onSetSidebarWidth: (width: number) => void
  onOpenPage: (page: SettingsPage) => void
  onCloseSettings: () => void
  onProfileChange: (profile: AgentProfileId) => void
  onContextCompressionThresholdChange: (ratio: number) => Promise<void>
  onClosePolicyChange: (policy: RuntimeState['closePolicy']) => Promise<boolean>
  onArchiveChanged: () => void | Promise<void>
}) {
  const returnHome = () => onOpenPage('home')
  const initialPageRef = useRef(page)
  const pageHasChangedRef = useRef(false)
  const [settingsQuery, setSettingsQuery] = useState('')

  if (page !== initialPageRef.current) {
    pageHasChangedRef.current = true
  }

  const normalizedQuery = settingsQuery.trim().toLocaleLowerCase()
  const filteredNavGroups = SETTINGS_NAV_GROUPS.map((group) => {
    if (!normalizedQuery || group.title.toLocaleLowerCase().includes(normalizedQuery)) {
      return group
    }
    return {
      ...group,
      items: group.items.filter((item) => (
        `${item.title} ${item.desc}`.toLocaleLowerCase().includes(normalizedQuery)
      )),
    }
  }).filter((group) => group.items.length > 0)

  return (
    <div className="settings-workspace">
      <div className="settings-layout">
        <div className="settings-sidebar-track" aria-hidden={sidebarCollapsed} {...(sidebarCollapsed ? { inert: '' } : {})}>
          <aside className="sidebar-surface settings-sidebar">
            <div className="settings-sidebar-contents">
            <div className="settings-sidebar-toolbar">
              <label className="settings-sidebar-search">
                <SearchIcon />
                <input
                  type="search"
                  value={settingsQuery}
                  onChange={(event) => setSettingsQuery(event.target.value)}
                  placeholder="搜索设置"
                  aria-label="搜索设置"
                />
              </label>
              <button
                className="settings-sidebar-exit"
                type="button"
                aria-label="退出设置页"
                onClick={onCloseSettings}
              >
                <CloseIcon />
                <span>退出设置</span>
              </button>
            </div>
            <section className="settings-nav-section" aria-label="设置分组">
              {filteredNavGroups.map((group) => (
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
                        </span>
                        <SettingsNavArrowIcon />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {filteredNavGroups.length === 0 && (
                <div className="settings-nav-empty">没有匹配的设置</div>
              )}
            </section>
            </div>
          </aside>
        </div>
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
            {page === 'application' && (
              <SettingsApplicationBackgroundPage
                closePolicy={runtime?.closePolicy ?? null}
                onClosePolicyChange={onClosePolicyChange}
              />
            )}
            {page === 'agent' && (
              <SettingsAgentProfilePage
                profile={runtime?.profile ?? 'general'}
                contextCompressionThresholdRatio={runtime?.contextCompressionThresholdRatio ?? 0.8}
                onChange={onProfileChange}
                onContextCompressionThresholdChange={onContextCompressionThresholdChange}
              />
            )}
            {page === 'api' && <Settings onClose={returnHome} embedded />}
            {page === 'web' && <SettingsWebPage />}
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
