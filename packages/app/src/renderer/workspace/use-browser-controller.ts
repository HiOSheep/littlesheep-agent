// Owns embedded-browser tabs and bounded URL history for the active conversation.
import { useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  createNewWorkspaceBrowserTab,
  createWorkspaceBrowserTab,
  isWorkspaceBrowserTabId,
  MAX_WORKSPACE_BROWSER_TABS,
  normalizeBrowserTabTitle,
  normalizeBrowserTabUrl,
  type WorkspaceBrowserTab,
  type WorkspaceBrowserTabId,
} from './browser-tabs'
import {
  appendWorkspaceBrowserHistory,
  browserUrlsShareHistoryEntry,
  createWorkspaceBrowserHistory,
  moveWorkspaceBrowserHistory,
  replaceWorkspaceBrowserHistory,
  type WorkspaceBrowserHistory,
} from './browser-history'
import {
  WORKSPACE_PANEL_OPEN_TABS_MAX,
  type WorkspacePanelTabId,
} from '../workspace-persistence'

export function useWorkspaceBrowserController({
  workspaceBrowserTabs,
  setWorkspaceBrowserTabs,
  workspacePanelTab,
  setWorkspacePanelTab,
  workspacePanelOpenTabs,
  setWorkspacePanelOpenTabs,
  setWorkspacePanelCollapsed,
  setRuntimeError,
}: {
  workspaceBrowserTabs: WorkspaceBrowserTab[]
  setWorkspaceBrowserTabs: Dispatch<SetStateAction<WorkspaceBrowserTab[]>>
  workspacePanelTab: WorkspacePanelTabId
  setWorkspacePanelTab: Dispatch<SetStateAction<WorkspacePanelTabId>>
  workspacePanelOpenTabs: WorkspacePanelTabId[]
  setWorkspacePanelOpenTabs: Dispatch<SetStateAction<WorkspacePanelTabId[]>>
  setWorkspacePanelCollapsed: Dispatch<SetStateAction<boolean>>
  setRuntimeError: Dispatch<SetStateAction<string | null>>
}) {
  const workspaceBrowserTabsRef = useRef(workspaceBrowserTabs)
  workspaceBrowserTabsRef.current = workspaceBrowserTabs
  const activeBrowserTabId: WorkspaceBrowserTabId | null = isWorkspaceBrowserTabId(workspacePanelTab)
    ? workspacePanelTab
    : null
  const activeBrowserTab = activeBrowserTabId
    ? workspaceBrowserTabs.find((tab) => tab.id === activeBrowserTabId) ?? null
    : null

  function commitBrowserTabs(next: WorkspaceBrowserTab[]) {
    workspaceBrowserTabsRef.current = next
    setWorkspaceBrowserTabs(next)
  }

  function updateBrowserTab(tabId: WorkspaceBrowserTabId, update: (tab: WorkspaceBrowserTab) => WorkspaceBrowserTab) {
    const current = workspaceBrowserTabsRef.current
    const index = current.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    const next = [...current]
    next[index] = update(current[index]!)
    commitBrowserTabs(next)
  }

  function ensureWorkspaceBrowserTab(tabId: WorkspaceBrowserTabId): WorkspaceBrowserTab {
    const existing = workspaceBrowserTabsRef.current.find((tab) => tab.id === tabId)
    if (existing) return existing
    const created = createWorkspaceBrowserTab('', tabId)
    commitBrowserTabs([...workspaceBrowserTabsRef.current, created])
    return created
  }

  function navigateWorkspaceBrowser(url: string, mode: 'push' | 'replace' = 'push') {
    const tabId = activeBrowserTabId
    if (!tabId) {
      openWorkspaceBrowserTab(url)
      return
    }
    const tab = ensureWorkspaceBrowserTab(tabId)
    const currentUrl = tab.history.entries[tab.history.index] ?? tab.url
    const sameHistoryEntry = mode === 'push' && browserUrlsShareHistoryEntry(currentUrl, url)
    const nextHistory = mode === 'replace'
      ? replaceWorkspaceBrowserHistory(tab.history, url)
      : appendWorkspaceBrowserHistory(tab.history, url)
    if (nextHistory === tab.history && tab.url === (nextHistory.entries[nextHistory.index] ?? '')) return
    updateBrowserTab(tabId, (current) => ({
      ...current,
      url: nextHistory.entries[nextHistory.index] ?? '',
      history: nextHistory,
      title: sameHistoryEntry
        ? current.title
        : normalizeBrowserTabTitle('', nextHistory.entries[nextHistory.index] ?? ''),
    }))
  }

  function openWorkspaceBrowser(url: string) {
    const normalizedUrl = normalizeBrowserTabUrl(url)
    if (!normalizedUrl) return
    openWorkspaceBrowserTab(normalizedUrl)
  }

  function openWorkspaceBrowserTab(url = '') {
    const normalizedUrl = normalizeBrowserTabUrl(url)
    if (url.trim() && !normalizedUrl) return
    if (workspaceBrowserTabsRef.current.length >= MAX_WORKSPACE_BROWSER_TABS) {
      setRuntimeError(`内置浏览器最多打开 ${MAX_WORKSPACE_BROWSER_TABS} 个标签`)
      return
    }
    if (workspacePanelOpenTabs.length >= WORKSPACE_PANEL_OPEN_TABS_MAX) {
      setRuntimeError(`拓展工作区最多打开 ${WORKSPACE_PANEL_OPEN_TABS_MAX} 个标签`)
      return
    }
    const tab = createNewWorkspaceBrowserTab(normalizedUrl)
    commitBrowserTabs([...workspaceBrowserTabsRef.current, tab])
    setWorkspacePanelOpenTabs((tabs) => tabs.includes(tab.id) ? tabs : [...tabs, tab.id])
    setWorkspacePanelTab(tab.id)
    setWorkspacePanelCollapsed(false)
  }

  function updateWorkspaceBrowserTitle(tabId: WorkspaceBrowserTabId, title: string) {
    updateBrowserTab(tabId, (tab) => ({
      ...tab,
      title: normalizeBrowserTabTitle(title, tab.url),
    }))
  }

  function moveWorkspaceBrowser(delta: number) {
    const tabId = activeBrowserTabId
    if (!tabId) return
    const tab = ensureWorkspaceBrowserTab(tabId)
    const nextHistory = moveWorkspaceBrowserHistory(tab.history, delta)
    if (nextHistory === tab.history) return
    updateBrowserTab(tabId, (current) => ({
      ...current,
      url: nextHistory.entries[nextHistory.index] ?? '',
      history: nextHistory,
      title: normalizeBrowserTabTitle('', nextHistory.entries[nextHistory.index] ?? ''),
    }))
  }

  function removeWorkspaceBrowserTab(tabId: WorkspaceBrowserTabId) {
    commitBrowserTabs(workspaceBrowserTabsRef.current.filter((tab) => tab.id !== tabId))
  }

  return {
    workspaceBrowserTabs,
    workspaceBrowserUrl: activeBrowserTab?.url ?? '',
    workspaceBrowserHistory: activeBrowserTab?.history ?? createWorkspaceBrowserHistory(),
    navigateWorkspaceBrowser,
    openWorkspaceBrowser,
    openWorkspaceBrowserTab,
    updateWorkspaceBrowserTitle,
    moveWorkspaceBrowser,
    ensureWorkspaceBrowserTab,
    removeWorkspaceBrowserTab,
  }
}
