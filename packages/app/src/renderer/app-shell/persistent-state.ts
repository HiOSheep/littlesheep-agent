// Versioned recovery state for stable renderer surfaces. Transient UI and authorization stay in memory.

import type { DirectModulePage, SettingsPage } from '../settings/types'
import type { AppRoute, SidebarPanel } from './types'

export const APP_SHELL_STATE_KEY = 'littlesheep.ui.appShellState'

export const APP_SHELL_STATE_WRITE_DELAY_MS = 160

const APP_SHELL_STATE_VERSION = 1 as const
const COMPOSER_DRAFT_MAX_CHARS = 262_144
const SIDEBAR_SEARCH_MAX_CHARS = 1_024
const SESSION_ID_MAX_CHARS = 512

const SETTINGS_PAGES = new Set<SettingsPage>([
  'home',
  'application',
  'appearance',
  'agent',
  'api',
  'web',
  'storage',
  'browser',
  'developmentEnvironments',
  'scheduled',
  'memoryTree',
  'archive',
  'plugins',
  'skills',
  'channels',
])

const DIRECT_MODULE_PAGES = new Set<DirectModulePage>(['memoryTree', 'scheduled', 'plugins'])

export interface PersistedAppShellState {
  version: 1
  route: AppRoute
  conversationCollapsed: boolean
  sidebarPanel: SidebarPanel
  sidebarSearch: string
  composerDraft: string
  composerSessionId: string | null
}

export function createDefaultPersistedAppShellState(): PersistedAppShellState {
  return {
    version: APP_SHELL_STATE_VERSION,
    route: { section: 'chat' },
    conversationCollapsed: false,
    sidebarPanel: null,
    sidebarSearch: '',
    composerDraft: '',
    composerSessionId: null,
  }
}

export function hydratePersistedAppShellState(input: unknown): PersistedAppShellState {
  const fallback = createDefaultPersistedAppShellState()
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback
  const value = input as Record<string, unknown>
  if (value.version !== APP_SHELL_STATE_VERSION) return fallback
  const route = normalizeRoute(value.route)
  return {
    version: APP_SHELL_STATE_VERSION,
    route,
    conversationCollapsed: value.conversationCollapsed === true,
    sidebarPanel: route.section === 'chat' && value.sidebarPanel === 'search' ? 'search' : null,
    sidebarSearch: boundedString(value.sidebarSearch, SIDEBAR_SEARCH_MAX_CHARS),
    composerDraft: boundedString(value.composerDraft, COMPOSER_DRAFT_MAX_CHARS),
    composerSessionId: nullableBoundedString(value.composerSessionId, SESSION_ID_MAX_CHARS),
  }
}

export function readPersistedAppShellState(): PersistedAppShellState {
  try {
    const raw = window.localStorage.getItem(APP_SHELL_STATE_KEY)
    return raw ? hydratePersistedAppShellState(JSON.parse(raw) as unknown) : createDefaultPersistedAppShellState()
  } catch {
    return createDefaultPersistedAppShellState()
  }
}

export function restoreComposerDraft(
  state: PersistedAppShellState,
  activeSessionId: string | null,
): string {
  return state.composerSessionId === activeSessionId ? state.composerDraft : ''
}

export function writePersistedAppShellState(state: PersistedAppShellState): void {
  try {
    window.localStorage.setItem(APP_SHELL_STATE_KEY, JSON.stringify(hydratePersistedAppShellState(state)))
  } catch {
    // UI recovery is best-effort and must never block the active renderer.
  }
}

function normalizeRoute(input: unknown): AppRoute {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { section: 'chat' }
  const value = input as Record<string, unknown>
  if (value.section === 'settings' && SETTINGS_PAGES.has(value.page as SettingsPage)) {
    return { section: 'settings', page: value.page as SettingsPage }
  }
  if (value.section === 'module' && DIRECT_MODULE_PAGES.has(value.page as DirectModulePage)) {
    return { section: 'module', page: value.page as DirectModulePage }
  }
  return { section: 'chat' }
}

function boundedString(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.slice(0, maxChars) : ''
}

function nullableBoundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.slice(0, maxChars)
  return normalized || null
}
