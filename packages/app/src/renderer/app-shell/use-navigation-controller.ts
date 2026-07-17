// Bounded in-memory navigation history and settings transition controller.
import '@xterm/xterm/css/xterm.css'
import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_NAVIGATION_EXPANDED_PATHS,
  MAX_NAVIGATION_HISTORY_ENTRIES,
  MAX_NAVIGATION_OPEN_TABS,
  appendNavigationEntry,
  boundStringList,
  replaceActiveNavigationEntry,
  type NavigationHistoryState,
} from '../navigation-history'
import { DirectModulePage, SettingsPage } from '../settings/types'
import { FloatingHelpTip } from '../ui/floating-help'
import {
  type WorkspaceOpenRequest,
  type WorkspacePanelTabId
} from '../workspace-persistence'
import { navigationSnapshotsEqual, routesEqual } from './navigation'
import { AppNavigationSnapshot, AppRoute, SidebarPanel } from './types'

export interface NavigationControllerInput {
  setControlTip: Dispatch<SetStateAction<FloatingHelpTip | null>>
  sidebarCollapsed: boolean
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>
  sidebarWidth: number
  setSidebarWidth: Dispatch<SetStateAction<number>>
  conversationCollapsed: boolean
  setConversationCollapsed: Dispatch<SetStateAction<boolean>>
  sidebarPanel: SidebarPanel
  setSidebarPanel: Dispatch<SetStateAction<SidebarPanel>>
  workspacePanelCollapsed: boolean
  setWorkspacePanelCollapsed: Dispatch<SetStateAction<boolean>>
  workspacePanelFullscreen: boolean
  setWorkspacePanelFullscreen: Dispatch<SetStateAction<boolean>>
  workspacePanelWidth: number
  setWorkspacePanelWidth: Dispatch<SetStateAction<number>>
  workspacePanelTab: WorkspacePanelTabId
  setWorkspacePanelTab: Dispatch<SetStateAction<WorkspacePanelTabId>>
  workspacePanelOpenTabs: WorkspacePanelTabId[]
  setWorkspacePanelOpenTabs: Dispatch<SetStateAction<WorkspacePanelTabId[]>>
  workspaceBrowserUrl: string
  setWorkspaceBrowserUrl: Dispatch<SetStateAction<string>>
  workspaceOpenRequest: WorkspaceOpenRequest | null
  setWorkspaceOpenRequest: Dispatch<SetStateAction<WorkspaceOpenRequest | null>>
  workspaceFileNavigatorCollapsed: boolean
  setWorkspaceFileNavigatorCollapsed: Dispatch<SetStateAction<boolean>>
  workspaceExpandedPaths: string[]
  setWorkspaceExpandedPaths: Dispatch<SetStateAction<string[]>>
}

export function useNavigationController({
  setControlTip, sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth,
  conversationCollapsed, setConversationCollapsed, sidebarPanel, setSidebarPanel,
  workspacePanelCollapsed, setWorkspacePanelCollapsed, workspacePanelFullscreen,
  setWorkspacePanelFullscreen, workspacePanelWidth, setWorkspacePanelWidth, workspacePanelTab,
  setWorkspacePanelTab, workspacePanelOpenTabs, setWorkspacePanelOpenTabs, workspaceBrowserUrl,
  setWorkspaceBrowserUrl, workspaceOpenRequest,
  setWorkspaceOpenRequest, workspaceFileNavigatorCollapsed, setWorkspaceFileNavigatorCollapsed,
  workspaceExpandedPaths, setWorkspaceExpandedPaths,
}: NavigationControllerInput) {

  const [activeRoute, setActiveRoute] = useState<AppRoute>({ section: 'chat' })
  const [appHistory, setAppHistory] = useState<NavigationHistoryState<AppNavigationSnapshot>>({
    entries: [],
    index: -1,
  })
  const lastRenderedSettingsPageRef = useRef<SettingsPage>('home')
  const settingsEntryRippleTimerRef = useRef<number>()
  const settingsEntryRippleFrameRef = useRef<number>()
  const navigationHistoryInitializedRef = useRef(false)
  const navigationRestoreTargetRef = useRef<AppNavigationSnapshot | null>(null)
  const navigationRestoreSettleTimerRef = useRef<number>()
  const appHistoryRef = useRef(appHistory)
  const settingsReturnRouteRef = useRef<AppRoute>({ section: 'chat' })
  const [settingsEntryRippling, setSettingsEntryRippling] = useState(false)

  const settingsOpen = activeRoute.section === 'settings'
  const directModulePage = activeRoute.section === 'module' ? activeRoute.page : null
  const routeSettingsPage = activeRoute.section === 'settings' ? activeRoute.page : 'home'
  if (settingsOpen) lastRenderedSettingsPageRef.current = routeSettingsPage
  const settingsPage = settingsOpen ? routeSettingsPage : lastRenderedSettingsPageRef.current
  const canNavigateBack = appHistory.index > 0
  const canNavigateForward = appHistory.index >= 0 && appHistory.index < appHistory.entries.length - 1

  const navigationSnapshot = useMemo<AppNavigationSnapshot>(() => ({
    route: activeRoute,
    sidebarCollapsed,
    sidebarWidth,
    conversationCollapsed,
    sidebarPanel,
    workspacePanelCollapsed,
    workspacePanelFullscreen,
    workspacePanelWidth,
    workspacePanelTab,
    workspacePanelOpenTabs: boundStringList(workspacePanelOpenTabs, MAX_NAVIGATION_OPEN_TABS) as WorkspacePanelTabId[],
    workspaceBrowserUrl,
    workspaceOpenRequest: workspaceOpenRequest
      ? { root: workspaceOpenRequest.root, path: workspaceOpenRequest.path }
      : null,
    workspaceFileNavigatorCollapsed,
    workspaceExpandedPaths: boundStringList(workspaceExpandedPaths, MAX_NAVIGATION_EXPANDED_PATHS),
  }), [
    activeRoute,
    conversationCollapsed,
    sidebarCollapsed,
    sidebarPanel,
    sidebarWidth,
    workspaceExpandedPaths,
    workspaceFileNavigatorCollapsed,
    workspaceOpenRequest,
    workspacePanelCollapsed,
    workspacePanelFullscreen,
    workspacePanelOpenTabs,
    workspacePanelTab,
    workspacePanelWidth,
    workspaceBrowserUrl,
  ])

  appHistoryRef.current = appHistory

  useEffect(() => {
    if (!navigationHistoryInitializedRef.current) {
      navigationHistoryInitializedRef.current = true
      setAppHistory({ entries: [navigationSnapshot], index: 0 })
      return
    }

    const restoreTarget = navigationRestoreTargetRef.current
    if (restoreTarget) {
      window.clearTimeout(navigationRestoreSettleTimerRef.current)
      navigationRestoreSettleTimerRef.current = window.setTimeout(() => {
        setAppHistory((current) => {
          const next = replaceActiveNavigationEntry(
            current,
            navigationSnapshot,
            (left, right) => navigationSnapshotsEqual(left, right),
          )
          appHistoryRef.current = next
          navigationRestoreTargetRef.current = null
          return next
        })
      }, 260)
      return () => window.clearTimeout(navigationRestoreSettleTimerRef.current)
    }

    const timer = window.setTimeout(() => {
      setAppHistory((current) => {
        const next = appendNavigationEntry(
          current,
          navigationSnapshot,
          (left, right) => navigationSnapshotsEqual(left, right),
          MAX_NAVIGATION_HISTORY_ENTRIES,
        )
        appHistoryRef.current = next
        return next
      })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [navigationSnapshot])

  function pushRoute(route: AppRoute) {
    setControlTip(null)
    setActiveRoute((current) => routesEqual(current, route) ? current : route)
  }

  function openSettingsRoot() {
    setSidebarPanel(null)
    pushRoute({ section: 'settings', page: 'home' })
  }

  function openSettingsFromEntry() {
    if (!settingsOpen) settingsReturnRouteRef.current = activeRoute
    triggerSettingsEntryRipple()
    openSettingsRoot()
  }

  function openSettingsPage(page: SettingsPage) {
    setSidebarPanel(null)
    pushRoute({ section: 'settings', page })
  }

  function openDirectModulePage(page: DirectModulePage) {
    setSidebarPanel(null)
    pushRoute({ section: 'module', page })
  }

  function navigateBack() {
    setControlTip(null)
    navigateHistoryTo(appHistoryRef.current.index - 1)
  }

  function navigateForward() {
    setControlTip(null)
    navigateHistoryTo(appHistoryRef.current.index + 1)
  }

  function navigateHistoryTo(index: number) {
    const current = appHistoryRef.current
    if (index < 0 || index >= current.entries.length || index === current.index) return
    const target = current.entries[index]
    if (!target) return
    navigationRestoreTargetRef.current = target
    restoreNavigationSnapshot(target)
    const next = { ...current, index }
    appHistoryRef.current = next
    setAppHistory(next)
  }

  function restoreNavigationSnapshot(snapshot: AppNavigationSnapshot) {
    setActiveRoute(snapshot.route)
    setSidebarCollapsed(snapshot.sidebarCollapsed)
    setSidebarWidth(snapshot.sidebarWidth)
    setConversationCollapsed(snapshot.conversationCollapsed)
    setSidebarPanel(snapshot.sidebarPanel)
    setWorkspacePanelCollapsed(snapshot.workspacePanelCollapsed)
    setWorkspacePanelFullscreen(snapshot.workspacePanelFullscreen)
    setWorkspacePanelWidth(snapshot.workspacePanelWidth)
    setWorkspacePanelTab(snapshot.workspacePanelTab)
    setWorkspacePanelOpenTabs(snapshot.workspacePanelOpenTabs)
    setWorkspaceBrowserUrl(snapshot.workspaceBrowserUrl)
    setWorkspaceOpenRequest(snapshot.workspaceOpenRequest
      ? { id: Date.now(), ...snapshot.workspaceOpenRequest }
      : null)
    setWorkspaceFileNavigatorCollapsed(snapshot.workspaceFileNavigatorCollapsed)
    setWorkspaceExpandedPaths(snapshot.workspaceExpandedPaths)
  }

  function closeSettingsWorkspace() {
    pushRoute(settingsReturnRouteRef.current)
  }

  function closeSettingsFromEntry() {
    triggerSettingsEntryRipple()
    closeSettingsWorkspace()
  }

  function triggerSettingsEntryRipple() {
    window.clearTimeout(settingsEntryRippleTimerRef.current)
    window.cancelAnimationFrame(settingsEntryRippleFrameRef.current ?? 0)
    setSettingsEntryRippling(false)
    settingsEntryRippleFrameRef.current = window.requestAnimationFrame(() => {
      setSettingsEntryRippling(true)
      settingsEntryRippleTimerRef.current = window.setTimeout(() => {
        setSettingsEntryRippling(false)
      }, 520)
    })
  }

  useEffect(() => () => {
    window.clearTimeout(settingsEntryRippleTimerRef.current)
    window.clearTimeout(navigationRestoreSettleTimerRef.current)
    window.cancelAnimationFrame(settingsEntryRippleFrameRef.current ?? 0)
  }, [])

  return { appHistoryRef, navigationRestoreTargetRef, setAppHistory, settingsEntryRippling, settingsOpen, directModulePage, settingsPage, canNavigateBack, canNavigateForward, pushRoute, openSettingsFromEntry, openSettingsPage, openDirectModulePage, navigateBack, navigateForward, closeSettingsFromEntry }
}

export type NavigationController = ReturnType<typeof useNavigationController>
