// @littlesheep/app - workspace-layout-index.ts
// Auditable mirror of renderer workspace layout recovery state.

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import {
  WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT,
  WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX,
  WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN,
  type WorkspaceLayoutBrowserTab,
  type WorkspaceLayoutFileDraft,
  type WorkspaceLayoutOpenRequest,
  type WorkspaceLayoutSnapshot,
  type WorkspaceLayoutTabId,
} from '../shared/workspace-contracts.js'
import { rebaseBoundPath, sameBoundPath } from './path-rebinding.js'

const WORKSPACE_LAYOUT_STORE_VERSION = 2 as const
const WORKSPACE_LAYOUT_STORE_MAX_SESSIONS = 96
const WORKSPACE_LAYOUT_DRAFT_KEY = 'draft'

interface WorkspaceLayoutStore {
  version: 2
  updatedAt: string
  snapshots: Record<string, WorkspaceLayoutSnapshot>
}

export type {
  WorkspaceLayoutFileDraft,
  WorkspaceLayoutBrowserTab,
  WorkspaceLayoutOpenRequest,
  WorkspaceLayoutSnapshot,
  WorkspaceLayoutTabId,
} from '../shared/workspace-contracts.js'

export class WorkspaceLayoutIndex {
  private readonly filePath: string
  private operationTail: Promise<void> = Promise.resolve()

  constructor(opts: { dataDir: string }) {
    this.filePath = resolve(opts.dataDir, 'workspace', 'layout.json')
  }

  async read(sessionId?: string | null): Promise<WorkspaceLayoutSnapshot | null> {
    const store = await this.readStore()
    if (!store) return null
    if (sessionId !== undefined) {
      return store.snapshots[workspaceLayoutSessionKey(sessionId ?? undefined)] ?? null
    }
    return latestWorkspaceLayoutSnapshot(store)
  }

  async save(input: unknown): Promise<WorkspaceLayoutSnapshot> {
    return this.serialize(async () => {
      const snapshot = normalizeWorkspaceLayoutSnapshot(input)
      const store = (await this.readStore()) ?? emptyWorkspaceLayoutStore()
      store.snapshots[workspaceLayoutSessionKey(snapshot.sessionId)] = snapshot
      const bounded = boundWorkspaceLayoutStore(store)
      await this.writeStore(bounded)
      return snapshot
    })
  }

  async rebindWorkspace(fromPath: string, toPath: string): Promise<WorkspaceLayoutSnapshot | null> {
    return this.serialize(async () => {
      const store = await this.readStore()
      if (!store) return null
      let changed = false
      const snapshots: Record<string, WorkspaceLayoutSnapshot> = {}
      for (const [key, snapshot] of Object.entries(store.snapshots)) {
        const rebound = rebindWorkspaceLayoutSnapshot(snapshot, fromPath, toPath)
        snapshots[key] = rebound.snapshot
        changed ||= rebound.changed
      }
      if (!changed) return latestWorkspaceLayoutSnapshot(store)
      const nextStore = {
        version: WORKSPACE_LAYOUT_STORE_VERSION,
        updatedAt: new Date().toISOString(),
        snapshots,
      } satisfies WorkspaceLayoutStore
      await this.writeStore(nextStore)
      return latestWorkspaceLayoutSnapshot(nextStore)
    })
  }

  private async readStore(): Promise<WorkspaceLayoutStore | null> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf-8')) as unknown
      if (isWorkspaceLayoutStore(data)) return normalizeWorkspaceLayoutStore(data)
      if (!isWorkspaceLayoutSnapshot(data)) return null
      return {
        version: WORKSPACE_LAYOUT_STORE_VERSION,
        updatedAt: data.updatedAt,
        snapshots: { [workspaceLayoutSessionKey(data.sessionId)]: data },
      }
    } catch {
      return null
    }
  }

  private async writeStore(store: WorkspaceLayoutStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await atomicWrite(this.filePath, JSON.stringify(store, null, 2))
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail.catch(() => undefined)
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    this.operationTail = previous.then(() => gate)
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function rebindWorkspaceLayoutSnapshot(
  snapshot: WorkspaceLayoutSnapshot,
  fromPath: string,
  toPath: string,
): { snapshot: WorkspaceLayoutSnapshot; changed: boolean } {
    const openRequest = snapshot.openRequest
      ? {
          root: rebaseBoundPath(snapshot.openRequest.root, fromPath, toPath),
          path: rebaseBoundPath(snapshot.openRequest.path, fromPath, toPath),
        }
      : null
    const openTabs = snapshot.openTabs.map((tab) => rebindWorkspaceFileTabId(tab, fromPath, toPath))
    const activeTab = rebindWorkspaceFileTabId(snapshot.activeTab, fromPath, toPath)
    const drafts: Record<string, WorkspaceLayoutFileDraft> = {}
    for (const [tab, draft] of Object.entries(snapshot.drafts)) {
      drafts[rebindWorkspaceFileTabId(tab, fromPath, toPath)] = {
        ...draft,
        path: rebaseBoundPath(draft.path, fromPath, toPath),
      }
    }
    const workspacePath = sameBoundPath(snapshot.workspacePath, fromPath)
      ? resolve(toPath)
      : snapshot.workspacePath
    const expandedPaths = (snapshot.expandedPaths ?? []).map((path) => (
      rebaseBoundPath(path, fromPath, toPath)
    ))
    const changed = workspacePath !== snapshot.workspacePath
      || openRequest?.root !== snapshot.openRequest?.root
      || openRequest?.path !== snapshot.openRequest?.path
      || activeTab !== snapshot.activeTab
      || openTabs.some((tab, index) => tab !== snapshot.openTabs[index])
      || expandedPaths.some((path, index) => path !== snapshot.expandedPaths?.[index])
      || Object.keys(drafts).some((tab) => !snapshot.drafts[tab] || drafts[tab]?.path !== snapshot.drafts[tab]?.path)
    return {
      changed,
      snapshot: changed
        ? { ...snapshot, workspacePath, openRequest, openTabs, activeTab, expandedPaths, drafts }
        : snapshot,
    }
}

function rebindWorkspaceFileTabId(tab: string, fromPath: string, toPath: string): string {
  const match = tab.match(/^file:([^|]+)\|(.+)$/u)
  if (!match) return tab
  try {
    const root = decodeURIComponent(match[1]!)
    const path = decodeURIComponent(match[2]!)
    const nextRoot = rebaseBoundPath(root, fromPath, toPath)
    const nextPath = rebaseBoundPath(path, fromPath, toPath)
    if (nextRoot === root && nextPath === path) return tab
    return `file:${encodeURIComponent(nextRoot)}|${encodeURIComponent(nextPath)}`
  } catch {
    return tab
  }
}

function normalizeWorkspaceLayoutSnapshot(input: unknown): WorkspaceLayoutSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('workspace layout snapshot must be an object')
  }
  const item = input as Record<string, unknown>
  const workspacePath = normalizeNonEmptyString(item.workspacePath, 'workspacePath')
  const activeTab = normalizeNonEmptyString(item.activeTab, 'activeTab')
  const openTabs = normalizeStringArray(item.openTabs, 64)
  const drafts = normalizeDrafts(item.drafts)

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    workspacePath,
    sessionId: normalizeOptionalString(item.sessionId),
    width: clampNumber(item.width, 280, 1200, 360),
    collapsed: item.collapsed === true,
    fullscreen: item.fullscreen === true,
    activeTab,
    openTabs: openTabs.length > 0 ? openTabs : ['files'],
    openRequest: normalizeOpenRequest(item.openRequest),
    fileNavigatorCollapsed: item.fileNavigatorCollapsed === true,
    fileNavigatorWidth: clampNumber(
      item.fileNavigatorWidth,
      WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN,
      WORKSPACE_FILE_NAVIGATOR_WIDTH_MAX,
      WORKSPACE_FILE_NAVIGATOR_WIDTH_DEFAULT,
    ),
    expandedPaths: normalizeStringArray(item.expandedPaths, 256, 4096),
    drafts,
    browserTabs: normalizeBrowserTabs(item.browserTabs),
  }
}

function normalizeOpenRequest(value: unknown): WorkspaceLayoutOpenRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const root = normalizeOptionalString(item.root)
  const path = normalizeOptionalString(item.path)
  return root && path ? { root, path } : null
}

function normalizeDrafts(value: unknown): Record<string, WorkspaceLayoutFileDraft> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const drafts: Record<string, WorkspaceLayoutFileDraft> = {}
  let totalChars = 0
  for (const [tab, rawDraft] of Object.entries(value as Record<string, unknown>)) {
    if (!rawDraft || typeof rawDraft !== 'object' || Array.isArray(rawDraft)) continue
    const item = rawDraft as Record<string, unknown>
    const path = normalizeOptionalString(item.path)
    const editorText = typeof item.editorText === 'string' ? item.editorText : null
    const savedText = typeof item.savedText === 'string' ? item.savedText : null
    if (!path || editorText === null || savedText === null || editorText === savedText) continue
    const chars = editorText.length + savedText.length
    if (chars > 256 * 1024 || totalChars + chars > 1024 * 1024) continue
    drafts[tab] = {
      path,
      modifiedAt: typeof item.modifiedAt === 'number' && Number.isFinite(item.modifiedAt) ? item.modifiedAt : undefined,
      editorText,
      savedText,
      editing: item.editing === true,
    }
    totalChars += chars
  }
  return drafts
}

function normalizeStringArray(value: unknown, max = 24, maxLength = 16_384): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim().slice(0, maxLength)
    if (normalized && !result.includes(normalized)) result.push(normalized)
    if (result.length >= max) break
  }
  return result
}

function normalizeBrowserTabs(value: unknown): WorkspaceLayoutBrowserTab[] {
  if (!Array.isArray(value)) return []
  const tabs: WorkspaceLayoutBrowserTab[] = []
  for (const rawTab of value) {
    if (!rawTab || typeof rawTab !== 'object' || Array.isArray(rawTab)) continue
    const item = rawTab as Record<string, unknown>
    const id = normalizeOptionalString(item.id)
    const title = normalizeOptionalString(item.title)
    const url = typeof item.url === 'string' ? item.url.trim().slice(0, 8192) : ''
    if (!id || !/^browser:[a-z0-9_-]+$/iu.test(id) || tabs.some((tab) => tab.id === id)) continue
    const history = normalizeBrowserHistory(item.history, url)
    tabs.push({
      id,
      title: (title ?? '浏览器').slice(0, 120),
      url: history.entries[history.index] ?? url,
      history,
    })
    if (tabs.length >= 12) break
  }
  return tabs
}

function normalizeBrowserHistory(value: unknown, fallbackUrl: string): WorkspaceLayoutBrowserTab['history'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallbackUrl ? { entries: [fallbackUrl], index: 0 } : { entries: [], index: -1 }
  }
  const item = value as Record<string, unknown>
  const entries = normalizeStringArray(item.entries, 50, 8192)
  if (fallbackUrl && !entries.includes(fallbackUrl)) entries.push(fallbackUrl)
  if (entries.length === 0) return { entries: [], index: -1 }
  const rawIndex = typeof item.index === 'number' && Number.isFinite(item.index)
    ? Math.trunc(item.index)
    : entries.length - 1
  return { entries, index: Math.max(0, Math.min(rawIndex, entries.length - 1)) }
}

function normalizeNonEmptyString(value: unknown, label: string): string {
  const normalized = normalizeOptionalString(value)
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback
}

function workspaceLayoutSessionKey(sessionId?: string): string {
  const normalized = normalizeOptionalString(sessionId)
  return normalized ? `session:${encodeURIComponent(normalized)}` : WORKSPACE_LAYOUT_DRAFT_KEY
}

function emptyWorkspaceLayoutStore(): WorkspaceLayoutStore {
  return {
    version: WORKSPACE_LAYOUT_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    snapshots: {},
  }
}

function boundWorkspaceLayoutStore(store: WorkspaceLayoutStore): WorkspaceLayoutStore {
  const snapshots = Object.fromEntries(
    Object.entries(store.snapshots)
      .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
      .slice(0, WORKSPACE_LAYOUT_STORE_MAX_SESSIONS),
  )
  return {
    version: WORKSPACE_LAYOUT_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    snapshots,
  }
}

function latestWorkspaceLayoutSnapshot(store: WorkspaceLayoutStore): WorkspaceLayoutSnapshot | null {
  let latest: WorkspaceLayoutSnapshot | null = null
  for (const snapshot of Object.values(store.snapshots)) {
    if (!latest || snapshot.updatedAt > latest.updatedAt) latest = snapshot
  }
  return latest
}

function normalizeWorkspaceLayoutStore(store: WorkspaceLayoutStore): WorkspaceLayoutStore {
  const snapshots: Record<string, WorkspaceLayoutSnapshot> = {}
  for (const snapshot of Object.values(store.snapshots)) {
    if (!isWorkspaceLayoutSnapshot(snapshot)) continue
    snapshots[workspaceLayoutSessionKey(snapshot.sessionId)] = snapshot
  }
  return boundWorkspaceLayoutStore({
    version: WORKSPACE_LAYOUT_STORE_VERSION,
    updatedAt: store.updatedAt,
    snapshots,
  })
}

function isWorkspaceLayoutStore(value: unknown): value is WorkspaceLayoutStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.version === WORKSPACE_LAYOUT_STORE_VERSION &&
    typeof item.updatedAt === 'string' &&
    Boolean(item.snapshots) &&
    typeof item.snapshots === 'object' &&
    !Array.isArray(item.snapshots)
}

function isWorkspaceLayoutSnapshot(value: unknown): value is WorkspaceLayoutSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.version === 1 &&
    typeof item.updatedAt === 'string' &&
    typeof item.workspacePath === 'string' &&
    typeof item.width === 'number' &&
    typeof item.collapsed === 'boolean' &&
    typeof item.fullscreen === 'boolean' &&
    typeof item.activeTab === 'string' &&
    Array.isArray(item.openTabs) &&
    typeof item.fileNavigatorCollapsed === 'boolean' &&
    (item.fileNavigatorWidth === undefined || typeof item.fileNavigatorWidth === 'number') &&
    (item.expandedPaths === undefined || Array.isArray(item.expandedPaths)) &&
    Boolean(item.drafts) &&
    typeof item.drafts === 'object' &&
    !Array.isArray(item.drafts) &&
    (item.browserTabs === undefined || Array.isArray(item.browserTabs))
}
