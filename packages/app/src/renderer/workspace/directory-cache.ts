// Bounded stale-while-revalidate cache shared by every workspace tree mount.
import {
  listWorkspaceDirectory,
  type WorkspaceDirectory,
  type WorkspaceEntry,
} from '../api'


export interface WorkspaceDirectoryState {
  entries: WorkspaceEntry[]
  truncated: boolean
  hiddenCount: number
}

export const MAX_WORKSPACE_DIRECTORY_CACHE_ENTRIES = 128
export const WORKSPACE_DIRECTORY_CACHE_TTL_MS = 5_000

interface WorkspaceDirectoryCacheEntry {
  directory: WorkspaceDirectory
  rootKey: string
  state: WorkspaceDirectoryState
  updatedAt: number
}

interface WorkspaceDirectoryCacheOptions {
  loader?: (root: string, path: string) => Promise<WorkspaceDirectory>
  maxEntries?: number
  now?: () => number
  ttlMs?: number
}

export interface WorkspaceDirectoryCache {
  load: (
    root: string,
    path: string,
    options?: { force?: boolean },
  ) => Promise<WorkspaceDirectory>
  read: (root: string) => Record<string, WorkspaceDirectoryState>
}

export function createWorkspaceDirectoryCache(
  options: WorkspaceDirectoryCacheOptions = {},
): WorkspaceDirectoryCache {
  const loader = options.loader ?? listWorkspaceDirectory
  const maxEntries = options.maxEntries ?? MAX_WORKSPACE_DIRECTORY_CACHE_ENTRIES
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? WORKSPACE_DIRECTORY_CACHE_TTL_MS
  const entries = new Map<string, WorkspaceDirectoryCacheEntry>()
  const inFlight = new Map<string, Promise<WorkspaceDirectory>>()

  function read(root: string): Record<string, WorkspaceDirectoryState> {
    const rootKey = comparablePath(root)
    const snapshot: Record<string, WorkspaceDirectoryState> = {}
    const touched: Array<[string, WorkspaceDirectoryCacheEntry]> = []
    for (const [key, entry] of entries) {
      if (entry.rootKey !== rootKey) continue
      snapshot[entry.directory.path] = entry.state
      touched.push([key, entry])
    }
    for (const [key, entry] of touched) touch(entries, key, entry)
    return snapshot
  }

  function load(
    root: string,
    path: string,
    loadOptions: { force?: boolean } = {},
  ): Promise<WorkspaceDirectory> {
    const key = cacheKey(root, path)
    const cached = entries.get(key)
    if (cached) touch(entries, key, cached)
    if (cached && !loadOptions.force && now() - cached.updatedAt <= ttlMs) {
      return Promise.resolve(cached.directory)
    }

    const pending = inFlight.get(key)
    if (pending) return pending

    const request = loader(root, path)
      .then((directory) => {
        const entry: WorkspaceDirectoryCacheEntry = {
          directory,
          rootKey: comparablePath(root),
          state: directoryState(directory),
          updatedAt: now(),
        }
        store(entries, cacheKey(root, path), entry, maxEntries)
        store(entries, cacheKey(root, directory.path), entry, maxEntries)
        return directory
      })
      .finally(() => {
        if (inFlight.get(key) === request) inFlight.delete(key)
      })
    inFlight.set(key, request)
    return request
  }

  return { load, read }
}

export const workspaceDirectoryCache = createWorkspaceDirectoryCache()


export function preloadWorkspaceDirectory(root: string): Promise<WorkspaceDirectory> {
  return workspaceDirectoryCache.load(root, root)
}


export function updateWorkspaceDirectoryCache(
  current: Record<string, WorkspaceDirectoryState>,
  requestedPath: string,
  resolvedPath: string,
  state: WorkspaceDirectoryState,
  rootPath: string,
): Record<string, WorkspaceDirectoryState> {
  const next = { ...current }
  delete next[requestedPath]
  delete next[resolvedPath]
  next[requestedPath] = state
  next[resolvedPath] = state

  const protectedPaths = new Set([rootPath, requestedPath, resolvedPath])
  let entryCount = Object.keys(next).length
  for (const key of Object.keys(next)) {
    if (entryCount <= MAX_WORKSPACE_DIRECTORY_CACHE_ENTRIES) break
    if (protectedPaths.has(key)) continue
    delete next[key]
    entryCount -= 1
  }
  return next
}

function directoryState(directory: WorkspaceDirectory): WorkspaceDirectoryState {
  return {
    entries: directory.entries,
    truncated: directory.truncated,
    hiddenCount: directory.hiddenCount,
  }
}

function store(
  entries: Map<string, WorkspaceDirectoryCacheEntry>,
  key: string,
  entry: WorkspaceDirectoryCacheEntry,
  maxEntries: number,
): void {
  touch(entries, key, entry)
  while (entries.size > Math.max(1, maxEntries)) {
    const oldest = entries.keys().next().value as string | undefined
    if (!oldest) break
    entries.delete(oldest)
  }
}

function touch(
  entries: Map<string, WorkspaceDirectoryCacheEntry>,
  key: string,
  entry: WorkspaceDirectoryCacheEntry,
): void {
  entries.delete(key)
  entries.set(key, entry)
}

function cacheKey(root: string, path: string): string {
  return `${comparablePath(root)}\u0000${comparablePath(path)}`
}

function comparablePath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return /^[a-z]:[\\/]/iu.test(trimmed) || trimmed.startsWith('\\\\')
    ? trimmed.replace(/\//gu, '\\').toLocaleLowerCase('en-US')
    : trimmed
}
