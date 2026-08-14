// Cross-mount file previews with short freshness and explicit memory budgets.
import {
  previewWorkspaceFile,
  type WorkspacePreview,
} from '../api'
import { createBoundedByteLru } from './bounded-byte-lru'

export const MAX_WORKSPACE_FILE_PREVIEW_CACHE_ENTRIES = 40
export const MAX_WORKSPACE_FILE_PREVIEW_CACHE_BYTES = 20 * 1024 * 1024
export const WORKSPACE_FILE_PREVIEW_CACHE_TTL_MS = 5_000

interface PreviewCacheEntry {
  updatedAt: number
  value: WorkspacePreview
}

interface WorkspaceFilePreviewCacheOptions {
  loader?: (root: string, path: string) => Promise<WorkspacePreview>
  maxBytes?: number
  maxEntries?: number
  now?: () => number
  ttlMs?: number
}

export interface WorkspaceFilePreviewCache {
  invalidate: (root: string, path: string) => void
  load: (
    root: string,
    path: string,
    options?: { force?: boolean },
  ) => Promise<WorkspacePreview>
  read: (root: string, path: string) => WorkspacePreview | null
  store: (root: string, path: string, preview: WorkspacePreview) => void
}

export function createWorkspaceFilePreviewCache(
  options: WorkspaceFilePreviewCacheOptions = {},
): WorkspaceFilePreviewCache {
  const loader = options.loader ?? previewWorkspaceFile
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? WORKSPACE_FILE_PREVIEW_CACHE_TTL_MS
  const entries = createBoundedByteLru<string, PreviewCacheEntry>({
    maxBytes: options.maxBytes ?? MAX_WORKSPACE_FILE_PREVIEW_CACHE_BYTES,
    maxEntries: options.maxEntries ?? MAX_WORKSPACE_FILE_PREVIEW_CACHE_ENTRIES,
    sizeOf: (entry) => estimateWorkspacePreviewBytes(entry.value),
  })
  const generations = new Map<string, number>()
  const requests = new Map<string, Promise<WorkspacePreview>>()

  function read(root: string, path: string): WorkspacePreview | null {
    return entries.read(cacheKey(root, path))?.value ?? null
  }

  function store(root: string, path: string, preview: WorkspacePreview): void {
    const key = cacheKey(root, path)
    if (requests.has(key)) generations.set(key, (generations.get(key) ?? 0) + 1)
    entries.set(key, { updatedAt: now(), value: preview })
  }

  function invalidate(root: string, path: string): void {
    const key = cacheKey(root, path)
    if (requests.has(key)) generations.set(key, (generations.get(key) ?? 0) + 1)
    entries.delete(key)
  }

  function load(
    root: string,
    path: string,
    loadOptions: { force?: boolean } = {},
  ): Promise<WorkspacePreview> {
    const key = cacheKey(root, path)
    const cached = entries.read(key)
    if (cached && !loadOptions.force && now() - cached.updatedAt <= ttlMs) {
      return Promise.resolve(cached.value)
    }
    const pending = requests.get(key)
    if (pending) return pending

    const generation = generations.get(key) ?? 0
    const request = loader(root, path)
      .then((preview) => {
        if ((generations.get(key) ?? 0) !== generation) {
          return entries.read(key)?.value ?? preview
        }
        entries.set(key, { updatedAt: now(), value: preview })
        return preview
      })
      .finally(() => {
        if (requests.get(key) === request) {
          requests.delete(key)
          generations.delete(key)
        }
      })
    requests.set(key, request)
    return request
  }

  return { invalidate, load, read, store }
}

export const workspaceFilePreviewCache = createWorkspaceFilePreviewCache()

export function estimateWorkspacePreviewBytes(preview: WorkspacePreview): number {
  let bytes = 512
    + stringBytes(preview.path)
    + stringBytes(preview.name)
    + stringBytes(preview.relativePath)

  if (preview.kind === 'text' || preview.kind === 'markdown') {
    bytes += stringBytes(preview.content)
    if (preview.kind === 'text') bytes += stringBytes(preview.language)
    return bytes
  }
  if (preview.kind === 'unsupported') return bytes + stringBytes(preview.reason)
  if (preview.kind !== 'office') return bytes

  bytes += stringBytes(preview.note)
  for (const section of preview.sections) {
    bytes += 128 + stringBytes(section.title)
    for (const paragraph of section.paragraphs ?? []) bytes += 32 + stringBytes(paragraph)
    for (const row of section.rows ?? []) {
      bytes += 32
      for (const cell of row) bytes += 24 + stringBytes(cell)
    }
  }
  return bytes
}

function stringBytes(value: string | undefined): number {
  return (value?.length ?? 0) * 2
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
