// Owns bounded Monaco text models and view states shared by workspace editors.

export const MAX_WORKSPACE_MONACO_MODELS = 40
export const MAX_WORKSPACE_MONACO_MODEL_BYTES = 20 * 1024 * 1024

export interface WorkspaceMonacoTextModel {
  dispose: () => void
  getValueLength: () => number
  isDisposed: () => boolean
  uri: { toString: () => string }
}

interface ModelEntry {
  leases: number
  model: WorkspaceMonacoTextModel
  retired: boolean
  viewState?: unknown
}

export interface WorkspaceMonacoModelRegistry {
  acquire: (model: WorkspaceMonacoTextModel | null) => () => void
  readViewState: <T>(uri: string) => T | undefined
  saveViewState: (uri: string, viewState: unknown) => void
}

export function createWorkspaceMonacoModelRegistry(options: {
  maxBytes?: number
  maxEntries?: number
} = {}): WorkspaceMonacoModelRegistry {
  const maxEntries = Math.max(1, options.maxEntries ?? MAX_WORKSPACE_MONACO_MODELS)
  const maxBytes = Math.max(1, options.maxBytes ?? MAX_WORKSPACE_MONACO_MODEL_BYTES)
  const entries = new Map<string, ModelEntry>()

  function acquire(model: WorkspaceMonacoTextModel | null): () => void {
    if (!model || model.isDisposed()) return () => undefined
    const uri = model.uri.toString()
    let entry = entries.get(uri)
    if (entry && (entry.model !== model || entry.model.isDisposed())) {
      if (!entry.model.isDisposed() && entry.leases === 0) entry.model.dispose()
      else if (!entry.model.isDisposed()) entry.retired = true
      const viewState = entry.viewState
      entries.delete(uri)
      entry = { leases: 0, model, retired: false, viewState }
    }
    entry ??= { leases: 0, model, retired: false }
    entry.leases += 1
    touch(entries, uri, entry)
    trim(entries, maxEntries, maxBytes)
    let released = false
    return () => {
      if (released) return
      released = true
      entry!.leases = Math.max(0, entry!.leases - 1)
      if (entry!.retired || entries.get(uri) !== entry) {
        if (entry!.leases === 0 && !entry!.model.isDisposed()) entry!.model.dispose()
        return
      }
      touch(entries, uri, entry!)
      trim(entries, maxEntries, maxBytes)
    }
  }

  function saveViewState(uri: string, viewState: unknown): void {
    const entry = entries.get(uri)
    if (!entry || entry.model.isDisposed()) return
    entry.viewState = viewState
    touch(entries, uri, entry)
  }

  function readViewState<T>(uri: string): T | undefined {
    const entry = entries.get(uri)
    if (!entry || entry.model.isDisposed()) return undefined
    touch(entries, uri, entry)
    return entry.viewState as T | undefined
  }

  return { acquire, readViewState, saveViewState }
}

function trim(
  entries: Map<string, ModelEntry>,
  maxEntries: number,
  maxBytes: number,
): void {
  for (const [uri, entry] of entries) {
    if (entry.model.isDisposed()) entries.delete(uri)
  }
  let totalBytes = modelBytes(entries)
  while (entries.size > maxEntries || totalBytes > maxBytes) {
    const idle = [...entries].find(([, entry]) => entry.leases === 0)
    if (!idle) return
    const [uri, entry] = idle
    const bytes = estimateModelBytes(entry.model)
    entries.delete(uri)
    if (!entry.model.isDisposed()) entry.model.dispose()
    totalBytes = Math.max(0, totalBytes - bytes)
  }
}

function modelBytes(entries: Map<string, ModelEntry>): number {
  let bytes = 0
  for (const entry of entries.values()) bytes += estimateModelBytes(entry.model)
  return bytes
}

function estimateModelBytes(model: WorkspaceMonacoTextModel): number {
  return 1_024 + Math.max(0, model.getValueLength()) * 2
}

function touch<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key)
  cache.set(key, value)
}

export const workspaceMonacoModelRegistry = createWorkspaceMonacoModelRegistry()
