// Extension workspace panels, files, terminal, artifacts, and view helpers.
import {
  type WorkspaceEntry
} from '../api'


export interface WorkspaceDirectoryState {
  entries: WorkspaceEntry[]
  truncated: boolean
  hiddenCount: number
}


export const MAX_WORKSPACE_DIRECTORY_CACHE_ENTRIES = 128


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
