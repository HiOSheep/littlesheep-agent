// Bounded browser-tab state for the embedded workspace browser.
// Page contents stay in Electron's persistent session; the renderer stores
// only enough URL metadata to restore the tab strip and bounded navigation.
import {
  MAX_WORKSPACE_BROWSER_HISTORY,
  compactWorkspaceBrowserHistory,
  createWorkspaceBrowserHistory,
  normalizeBrowserUrl,
  type WorkspaceBrowserHistory,
} from './browser-history'

export const MAX_WORKSPACE_BROWSER_TABS = 12
export const MAX_BROWSER_TAB_TITLE_LENGTH = 120
export const MAX_BROWSER_URL_LENGTH = 8192
export const LEGACY_WORKSPACE_BROWSER_TAB_ID = 'browser:legacy' as const

export type WorkspaceBrowserTabId = `browser:${string}`

export interface WorkspaceBrowserTab {
  id: WorkspaceBrowserTabId
  title: string
  url: string
  history: WorkspaceBrowserHistory
}

let browserTabSequence = 0

export function isWorkspaceBrowserTabId(value: unknown): value is WorkspaceBrowserTabId {
  return typeof value === 'string' && /^browser:[a-z0-9_-]+$/iu.test(value)
}

export function createWorkspaceBrowserTabId(): WorkspaceBrowserTabId {
  browserTabSequence = (browserTabSequence + 1) % 1_000_000
  return `browser:${Date.now().toString(36)}-${browserTabSequence.toString(36)}`
}

export function createWorkspaceBrowserTab(
  url = '',
  id: WorkspaceBrowserTabId = createWorkspaceBrowserTabId(),
  title = '浏览器',
): WorkspaceBrowserTab {
  const normalizedUrl = normalizeBrowserTabUrl(url)
  return {
    id,
    title: normalizeBrowserTabTitle(title, normalizedUrl),
    url: normalizedUrl,
    history: createWorkspaceBrowserHistory(normalizedUrl),
  }
}

export function createNewWorkspaceBrowserTab(url = ''): WorkspaceBrowserTab {
  return createWorkspaceBrowserTab(url, createWorkspaceBrowserTabId())
}

export function hydrateWorkspaceBrowserTabs(value: unknown): WorkspaceBrowserTab[] {
  const tabs: WorkspaceBrowserTab[] = []
  if (Array.isArray(value)) {
    for (const raw of value) {
      const tab = normalizeWorkspaceBrowserTab(raw)
      if (!tab || tabs.some((item) => item.id === tab.id)) continue
      tabs.push(tab)
      if (tabs.length >= MAX_WORKSPACE_BROWSER_TABS) break
    }
  }
  return tabs.slice(0, MAX_WORKSPACE_BROWSER_TABS)
}

export function serializeWorkspaceBrowserTabs(tabs: WorkspaceBrowserTab[]): WorkspaceBrowserTab[] {
  return hydrateWorkspaceBrowserTabs(tabs).map((tab) => {
    const entries = tab.history.entries.slice(-MAX_WORKSPACE_BROWSER_HISTORY)
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      history: {
        entries,
        index: entries.length === 0
          ? -1
          : Math.max(0, Math.min(tab.history.index, entries.length - 1)),
      },
    }
  })
}

export function normalizeBrowserTabUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_BROWSER_URL_LENGTH) return ''
  return normalizeBrowserUrl(value)
}

export function normalizeBrowserTabTitle(value: unknown, url = ''): string {
  const title = typeof value === 'string' ? value.trim().slice(0, MAX_BROWSER_TAB_TITLE_LENGTH) : ''
  if (title) return title
  if (url) {
    try {
      return new URL(url).hostname || '浏览器'
    } catch {
      // Fall through to the stable default label.
    }
  }
  return '浏览器'
}

function normalizeWorkspaceBrowserTab(value: unknown): WorkspaceBrowserTab | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const id = normalizeWorkspaceBrowserTabId(raw.id)
  if (!id) return null
  const url = normalizeBrowserTabUrl(raw.url)
  const history = normalizeBrowserHistory(raw.history, url)
  const currentUrl = history.entries[history.index] ?? url
  return {
    id,
    title: normalizeBrowserTabTitle(raw.title, currentUrl),
    url: currentUrl,
    history,
  }
}

function normalizeWorkspaceBrowserTabId(value: unknown): WorkspaceBrowserTabId | null {
  // Older builds used `browser` both as the launcher and as a persistent page.
  // Keep that page recoverable while moving it out of the launcher namespace.
  if (value === 'browser') return LEGACY_WORKSPACE_BROWSER_TAB_ID
  return isWorkspaceBrowserTabId(value) ? value : null
}

function normalizeBrowserHistory(value: unknown, fallbackUrl: string): WorkspaceBrowserHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createWorkspaceBrowserHistory(fallbackUrl)
  }
  const raw = value as Record<string, unknown>
  const rawEntries = Array.isArray(raw.entries) ? raw.entries : []
  const entries = rawEntries
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizeBrowserTabUrl)
    .filter(Boolean)
    .slice(-MAX_WORKSPACE_BROWSER_HISTORY)
  if (fallbackUrl && !entries.includes(fallbackUrl)) entries.push(fallbackUrl)
  if (entries.length === 0) return createWorkspaceBrowserHistory()
  const rawIndex = typeof raw.index === 'number' && Number.isFinite(raw.index) ? Math.trunc(raw.index) : entries.length - 1
  return compactWorkspaceBrowserHistory({
    entries,
    index: Math.max(0, Math.min(rawIndex, entries.length - 1)),
  })
}
