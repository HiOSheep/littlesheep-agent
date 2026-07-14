// @littlesheep/app - workspace-layout-index.ts
// Auditable mirror of renderer workspace layout recovery state.

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { atomicWrite } from '@littlesheep/memory-core'
import { rebaseBoundPath, sameBoundPath } from './path-rebinding.js'

export type WorkspaceLayoutTabId = string

export interface WorkspaceLayoutOpenRequest {
  root: string
  path: string
}

export interface WorkspaceLayoutFileDraft {
  path: string
  modifiedAt?: number
  editorText: string
  savedText: string
  editing: boolean
}

export interface WorkspaceLayoutSnapshot {
  version: 1
  updatedAt: string
  workspacePath: string
  sessionId?: string
  width: number
  collapsed: boolean
  fullscreen: boolean
  activeTab: WorkspaceLayoutTabId
  openTabs: WorkspaceLayoutTabId[]
  openRequest: WorkspaceLayoutOpenRequest | null
  fileNavigatorCollapsed: boolean
  drafts: Record<string, WorkspaceLayoutFileDraft>
}

export class WorkspaceLayoutIndex {
  private readonly filePath: string

  constructor(opts: { dataDir: string }) {
    this.filePath = resolve(opts.dataDir, 'workspace', 'layout.json')
  }

  async read(): Promise<WorkspaceLayoutSnapshot | null> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf-8')) as unknown
      return isWorkspaceLayoutSnapshot(data) ? data : null
    } catch {
      return null
    }
  }

  async save(input: unknown): Promise<WorkspaceLayoutSnapshot> {
    const snapshot = normalizeWorkspaceLayoutSnapshot(input)
    await mkdir(dirname(this.filePath), { recursive: true })
    await atomicWrite(this.filePath, JSON.stringify(snapshot, null, 2))
    return snapshot
  }

  async rebindWorkspace(fromPath: string, toPath: string): Promise<WorkspaceLayoutSnapshot | null> {
    const snapshot = await this.read()
    if (!snapshot) return null
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
    const changed = workspacePath !== snapshot.workspacePath
      || openRequest?.root !== snapshot.openRequest?.root
      || openRequest?.path !== snapshot.openRequest?.path
      || activeTab !== snapshot.activeTab
      || openTabs.some((tab, index) => tab !== snapshot.openTabs[index])
      || Object.keys(drafts).some((tab) => !snapshot.drafts[tab] || drafts[tab]?.path !== snapshot.drafts[tab]?.path)
    if (!changed) return snapshot
    return this.save({ ...snapshot, workspacePath, openRequest, openTabs, activeTab, drafts })
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
  const openTabs = normalizeStringArray(item.openTabs)
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
    drafts,
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

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim()
    if (normalized && !result.includes(normalized)) result.push(normalized)
  }
  return result.slice(0, 24)
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
    Boolean(item.drafts) &&
    typeof item.drafts === 'object' &&
    !Array.isArray(item.drafts)
}
