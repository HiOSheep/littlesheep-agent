// Settings navigation and page composition.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type AgentProfileId,
  type RuntimeState
} from '../api'
import { isDirectModulePage } from '../app-shell/navigation'
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from '../app-shell/preferences'
import { ArchiveManager } from '../ArchiveManager'
import { ChannelConnections } from '../ChannelConnections'
import { MemorySkills } from '../MemorySkills'
import { useEscapeScope } from '../ui/modal-surface'
import { SettingsAgentProfilePage } from './agent-profile'
import { SettingsAppearancePage } from './appearance'
import { SettingsApplicationBackgroundPage } from './application-background'
import { DirectModulePageContent } from './direct-module'
import { SettingsHome } from './home'
import { SettingsModelsPage } from './models'
import { commonSettingsNavGroups, filterSettingsNavGroups, settingsSearchNavGroups } from './navigation'
import { SettingsStoragePage } from './storage'
import { SettingsUsagePage } from '../usage/settings-usage-page'
import { SettingsBrowserPage } from './browser'
import { SettingsDevelopmentEnvironmentsPage } from './development-environments'
import { SettingsWebPage } from './web'
import { SettingsPage } from './types'
import {
  SETTINGS_FIELD_LANDING_TIMEOUT_MS,
  SETTINGS_FIELD_LISTBOX_ID,
  revealSettingsField,
  searchSettingsFields,
  settingsFieldDefinition,
  settingsFieldOptionId,
  settingsFieldSelector,
  type SettingsFieldHit,
} from './search-index'
import { CloseIcon, SearchIcon, SettingsNavArrowIcon } from '../ui/icons'
import { WindowDragRegion } from '../sidebar/global-titlebar'


/** Where a field landing is waiting for its row to appear (page render, reveal click, Runtime load). */
interface PendingFieldLanding {
  id: string
  page: SettingsPage
  pageTitle: string
  token: number
}


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
  onContextCompressionThresholdChange: (ratio: number) => Promise<string | null>
  onClosePolicyChange: (policy: RuntimeState['closePolicy']) => Promise<boolean>
  onArchiveChanged: () => void | Promise<void>
}) {
  const returnHome = () => onOpenPage('home')
  const initialPageRef = useRef(page)
  const pageHasChangedRef = useRef(false)
  const [settingsQuery, setSettingsQuery] = useState('')
  const [activeFieldIndex, setActiveFieldIndex] = useState(-1)
  // Escape dismisses the result list without touching the query; typing brings it back.
  const [fieldResultsDismissed, setFieldResultsDismissed] = useState(false)
  const [landingNote, setLandingNote] = useState('')
  const [pendingLanding, setPendingLanding] = useState<PendingFieldLanding | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const landingTokenRef = useRef(0)

  if (page !== initialPageRef.current) {
    pageHasChangedRef.current = true
  }

  // S3：字段级结果。标签、别名、所在分组/页面/小节和可安全发布的当前值都来自
  // `search-index.ts` 的那一份登记；这里只负责把它接到现有的搜索框上。
  const fieldHits = useMemo(
    () => searchSettingsFields(settingsQuery, { runtime }),
    [settingsQuery, runtime],
  )
  const fieldResultsVisible = fieldHits.length > 0 && !fieldResultsDismissed
  const activeHitIndex = fieldResultsVisible && activeFieldIndex >= 0
    ? Math.min(activeFieldIndex, fieldHits.length - 1)
    : -1
  const activeHit = activeHitIndex >= 0 ? fieldHits[activeHitIndex] ?? null : null

  // 侧栏默认只显示常用导航；搜索时切换到完整索引，因此未接入的占位页仍能被找到并打开。
  const filteredNavGroups = filterSettingsNavGroups(
    settingsQuery,
    settingsQuery.trim() ? settingsSearchNavGroups() : commonSettingsNavGroups(),
  )

  /**
   * Escape 只归最上层：结果列表开着时，它关掉列表并把光标还给搜索框，不改查询、不翻页、
   * 不关设置、不打开字段。列表关着时这个 scope 不注册，`<input type="search">` 的原生清除行为
   * 保持不变（Escape 的第二下仍然清空查询）。
   */
  useEscapeScope(() => {
    setFieldResultsDismissed(true)
    setActiveFieldIndex(-1)
    searchInputRef.current?.focus({ preventScroll: true })
  }, fieldResultsVisible)

  const takeFieldHit = useCallback((hit: SettingsFieldHit) => {
    setLandingNote('')
    // 结果被取走就收起列表（和其它搜索表面一致）；查询文本不再需要，因为光标已经落到字段上。
    setSettingsQuery('')
    setActiveFieldIndex(-1)
    setFieldResultsDismissed(false)
    if (hit.page !== page) onOpenPage(hit.page)
    landingTokenRef.current += 1
    setPendingLanding({ id: hit.id, page: hit.page, pageTitle: hit.pageTitle, token: landingTokenRef.current })
  }, [onOpenPage, page])

  /**
   * 等目标行出现，然后把它带进视野、落下光标。
   *
   * 这里**不拥有焦点**：进入/离开表面的焦点规则归 `ui/focus-ownership.ts`，本循环只等一个元素
   * （页面渲染、`reveal` 控件被点开、Runtime 状态加载完成都可能让它晚到），等待有上限，超时就
   * 如实说明没能定位，而不是悄悄什么都不做。等待方式与 focus-ownership 的有界重试同形：
   * requestAnimationFrame 加一个被夹住的定时器，窗口不在前台时也不会把 500ms 预算烧在几帧上。
   */
  useEffect(() => {
    if (!pendingLanding) return
    const definition = settingsFieldDefinition(pendingLanding.id)
    let frame = 0
    let timer: number | null = null
    let revealClicked = false
    let cancelled = false
    const deadline = performance.now() + SETTINGS_FIELD_LANDING_TIMEOUT_MS
    const finish = (note: string) => {
      if (cancelled) return
      if (frame) window.cancelAnimationFrame(frame)
      if (timer !== null) window.clearTimeout(timer)
      frame = 0
      timer = null
      setPendingLanding(null)
      setLandingNote(note)
    }
    const attempt = () => {
      if (cancelled) return
      const selector = settingsFieldSelector(pendingLanding.id)
      if (page === pendingLanding.page && document.querySelector(selector)) {
        revealSettingsField(pendingLanding.id)
        finish('')
        return
      }
      // 字段只在某个控件被激活后才存在时（折叠的高级区、嵌套的供应商编辑器），先点它一次。
      if (!revealClicked && definition?.reveal) {
        const control = document.querySelector<HTMLElement>(definition.reveal)
        if (control) {
          revealClicked = true
          control.click()
        }
      }
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        finish(`已打开「${pendingLanding.pageTitle}」，但没能定位「${definition?.title ?? pendingLanding.id}」。`)
        return
      }
      frame = window.requestAnimationFrame(attempt)
      timer = window.setTimeout(attempt, Math.min(16, remaining))
    }
    attempt()
    return () => {
      cancelled = true
      if (frame) window.cancelAnimationFrame(frame)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [page, pendingLanding])

  function changeSearchQuery(value: string) {
    setSettingsQuery(value)
    setActiveFieldIndex(-1)
    setFieldResultsDismissed(false)
    setLandingNote('')
  }

  /**
   * 搜索框的键盘约定（组合框）：上下箭头移动结果环，Enter 打开当前结果，光标始终留在输入框里
   * （`aria-activedescendant`，不是把焦点搬进列表），所以 Escape 不需要把焦点搬回来。
   */
  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (fieldHits.length === 0) return
      event.preventDefault()
      setFieldResultsDismissed(false)
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveFieldIndex((current) => {
        const base = current < 0 ? (step === 1 ? -1 : 0) : current
        return (base + step + fieldHits.length) % fieldHits.length
      })
      return
    }
    if (event.key === 'Enter' && activeHit) {
      event.preventDefault()
      takeFieldHit(activeHit)
    }
  }

  return (
    <div className="settings-workspace">
      <div className="settings-layout">
        {/* The settings rail is the window's top-left corner while settings is open, so
            it carries the same transparent drag surface the app sidebar does; without it
            the window could not be dragged from its top-left in this view. */}
        <WindowDragRegion className="window-drag-band" />
        <div className="settings-sidebar-track" aria-hidden={sidebarCollapsed} {...(sidebarCollapsed ? { inert: '' } : {})}>
          <aside className="sidebar-surface settings-sidebar">
            <div className="settings-sidebar-contents">
            <div className="settings-sidebar-toolbar">
              <label className="settings-sidebar-search">
                <SearchIcon />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={settingsQuery}
                  onChange={(event) => changeSearchQuery(event.target.value)}
                  onKeyDown={onSearchKeyDown}
                  placeholder="搜索设置"
                  aria-label="搜索设置"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={fieldResultsVisible}
                  aria-controls={fieldResultsVisible ? SETTINGS_FIELD_LISTBOX_ID : undefined}
                  aria-activedescendant={activeHitIndex >= 0 ? settingsFieldOptionId(activeHitIndex) : undefined}
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
              {fieldResultsVisible && (
                <div
                  className="settings-field-results"
                  id={SETTINGS_FIELD_LISTBOX_ID}
                  role="listbox"
                  aria-label="设置项搜索结果"
                >
                  <div className="settings-nav-group-title">设置项</div>
                  {fieldHits.map((hit, index) => (
                    <button
                      key={hit.id}
                      id={settingsFieldOptionId(index)}
                      className={`settings-field-result ${index === activeHitIndex ? 'active' : ''}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeHitIndex}
                      data-settings-field-result={hit.id}
                      onClick={() => takeFieldHit(hit)}
                    >
                      <span className="settings-field-result-path">{hit.path}</span>
                      {hit.value !== null
                        ? <small className="settings-field-result-value">当前：{hit.value}</small>
                        : hit.kind === 'field'
                          ? <small className="settings-field-result-value">值不参与搜索</small>
                          : null}
                    </button>
                  ))}
                </div>
              )}
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
              {filteredNavGroups.length === 0 && fieldHits.length === 0 && (
                <div className="settings-nav-empty" role="status">
                  没有匹配的设置项。试试字段名，例如「关闭窗口」「压缩阈值」「API Key」。
                </div>
              )}
              {landingNote && <div className="settings-search-note" role="status">{landingNote}</div>}
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
            {page === 'home' && <SettingsHome runtime={runtime} onOpenPage={onOpenPage} />}
            {page === 'application' && (
              <SettingsApplicationBackgroundPage
                closePolicy={runtime?.closePolicy ?? null}
                onClosePolicyChange={onClosePolicyChange}
              />
            )}
            {page === 'appearance' && <SettingsAppearancePage />}
            {page === 'agent' && (
              <SettingsAgentProfilePage
                profile={runtime?.profile ?? 'general'}
                contextCompressionThresholdRatio={runtime?.contextCompressionThresholdRatio ?? 0.8}
                onChange={onProfileChange}
                onContextCompressionThresholdChange={onContextCompressionThresholdChange}
              />
            )}
            {page === 'api' && <SettingsModelsPage />}
            {page === 'usage' && <SettingsUsagePage />}
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
