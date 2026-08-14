// Bounded stale-while-revalidate cache for Git review snapshots and file diffs.
import {
  getWorkspaceReview,
  getWorkspaceReviewDiff,
  type WorkspaceReviewFileDiff,
  type WorkspaceReviewSnapshot,
} from '../api'
import { createBoundedByteLru } from './bounded-byte-lru'

export const MAX_WORKSPACE_REVIEW_SNAPSHOTS = 8
export const MAX_WORKSPACE_REVIEW_DIFFS = 32
export const MAX_WORKSPACE_REVIEW_DIFF_BYTES = 20 * 1024 * 1024
export const WORKSPACE_REVIEW_CACHE_TTL_MS = 5_000
export const WORKSPACE_REVIEW_DIFF_CACHE_TTL_MS = 30_000

interface CacheEntry<T> {
  updatedAt: number
  value: T
}

interface WorkspaceReviewCacheOptions {
  loadDiff?: (
    root: string,
    path: string,
    revision: string,
    options?: { signal?: AbortSignal },
  ) => Promise<WorkspaceReviewFileDiff>
  loadSnapshot?: (
    root: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ) => Promise<WorkspaceReviewSnapshot>
  maxDiffs?: number
  maxDiffBytes?: number
  maxSnapshots?: number
  now?: () => number
  diffTtlMs?: number
  snapshotTtlMs?: number
}

export interface WorkspaceReviewCache {
  loadDiff: (
    root: string,
    path: string,
    revision: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ) => Promise<WorkspaceReviewFileDiff>
  loadSnapshot: (
    root: string,
    options?: { force?: boolean; signal?: AbortSignal },
  ) => Promise<WorkspaceReviewSnapshot>
  readDiff: (root: string, path: string, revision: string) => WorkspaceReviewFileDiff | null
  readSnapshot: (root: string) => WorkspaceReviewSnapshot | null
}

export function createWorkspaceReviewCache(
  options: WorkspaceReviewCacheOptions = {},
): WorkspaceReviewCache {
  const loadSnapshotRequest = options.loadSnapshot ?? ((root, loadOptions) => (
    getWorkspaceReview(root, loadOptions)
  ))
  const loadDiffRequest = options.loadDiff ?? ((root, path, revision, loadOptions) => (
    getWorkspaceReviewDiff(root, path, revision, loadOptions)
  ))
  const maxSnapshots = options.maxSnapshots ?? MAX_WORKSPACE_REVIEW_SNAPSHOTS
  const maxDiffs = options.maxDiffs ?? MAX_WORKSPACE_REVIEW_DIFFS
  const maxDiffBytes = options.maxDiffBytes ?? MAX_WORKSPACE_REVIEW_DIFF_BYTES
  const now = options.now ?? Date.now
  const snapshotTtlMs = options.snapshotTtlMs ?? WORKSPACE_REVIEW_CACHE_TTL_MS
  const diffTtlMs = options.diffTtlMs ?? WORKSPACE_REVIEW_DIFF_CACHE_TTL_MS
  const snapshots = new Map<string, CacheEntry<WorkspaceReviewSnapshot>>()
  const diffs = createBoundedByteLru<string, CacheEntry<WorkspaceReviewFileDiff>>({
    maxBytes: maxDiffBytes,
    maxEntries: maxDiffs,
    sizeOf: (entry) => estimateWorkspaceReviewDiffBytes(entry.value),
  })
  const snapshotRequests = new Map<string, SharedRequest<WorkspaceReviewSnapshot>>()
  const diffRequests = new Map<string, SharedRequest<WorkspaceReviewFileDiff>>()

  function readSnapshot(root: string): WorkspaceReviewSnapshot | null {
    const key = comparablePath(root)
    const entry = snapshots.get(key)
    if (!entry) return null
    touch(snapshots, key, entry)
    return entry.value
  }

  function loadSnapshot(
    root: string,
    loadOptions: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<WorkspaceReviewSnapshot> {
    const key = comparablePath(root)
    const cached = snapshots.get(key)
    if (cached) touch(snapshots, key, cached)
    if (cached && !loadOptions.force && now() - cached.updatedAt <= snapshotTtlMs) {
      return Promise.resolve(cached.value)
    }
    let request = snapshotRequests.get(key)
    if (request?.controller.signal.aborted) {
      snapshotRequests.delete(key)
      request = undefined
    }
    if (!request) {
      const controller = new AbortController()
      request = createSharedRequest(controller, loadSnapshotRequest(root, {
        force: loadOptions.force,
        signal: controller.signal,
      }).then((snapshot) => {
        store(snapshots, key, { updatedAt: now(), value: snapshot }, maxSnapshots)
        return snapshot
      }), () => {
        if (snapshotRequests.get(key) === request) snapshotRequests.delete(key)
      })
      snapshotRequests.set(key, request)
    }
    return observeSharedRequest(request, loadOptions.signal)
  }

  function readDiff(root: string, path: string, revision: string): WorkspaceReviewFileDiff | null {
    const key = diffKey(root, path, revision)
    return diffs.read(key)?.value ?? null
  }

  function loadDiff(
    root: string,
    path: string,
    revision: string,
    loadOptions: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<WorkspaceReviewFileDiff> {
    const key = diffKey(root, path, revision)
    const cached = diffs.read(key)
    if (cached && !loadOptions.force && now() - cached.updatedAt <= diffTtlMs) {
      return Promise.resolve(cached.value)
    }
    let request = diffRequests.get(key)
    if (request?.controller.signal.aborted) {
      diffRequests.delete(key)
      request = undefined
    }
    if (!request) {
      const controller = new AbortController()
      request = createSharedRequest(controller, loadDiffRequest(root, path, revision, {
        signal: controller.signal,
      }).then((diff) => {
        diffs.set(key, { updatedAt: now(), value: diff })
        return diff
      }), () => {
        if (diffRequests.get(key) === request) diffRequests.delete(key)
      })
      diffRequests.set(key, request)
    }
    return observeSharedRequest(request, loadOptions.signal)
  }

  return { loadDiff, loadSnapshot, readDiff, readSnapshot }
}

export function estimateWorkspaceReviewDiffBytes(diff: WorkspaceReviewFileDiff): number {
  let bytes = 1_024
  bytes += estimateReviewFileBytes(diff.file)
  bytes += stringBytes(diff.workspacePath) + stringBytes(diff.repositoryRoot) + stringBytes(diff.notice)
  for (const layer of diff.layers) {
    bytes += 256 + stringBytes(layer.notice)
    for (const hunk of layer.hunks) {
      bytes += 128 + stringBytes(hunk.header)
      for (const line of hunk.lines) {
        bytes += 64 + stringBytes(line.content)
      }
    }
  }
  return bytes
}

function estimateReviewFileBytes(file: WorkspaceReviewFileDiff['file']): number {
  return 256
    + stringBytes(file.path)
    + stringBytes(file.absolutePath)
    + stringBytes(file.oldPath)
}

function stringBytes(value: string | undefined): number {
  return (value?.length ?? 0) * 2
}

export const workspaceReviewCache = createWorkspaceReviewCache()

function diffKey(root: string, path: string, revision: string): string {
  return `${comparablePath(root)}\u0000${path}\u0000${revision}`
}

function comparablePath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  return /^[a-z]:[\\/]/iu.test(trimmed) || trimmed.startsWith('\\\\')
    ? trimmed.replace(/\//gu, '\\').toLocaleLowerCase('en-US')
    : trimmed
}

function store<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  entry: CacheEntry<T>,
  maxEntries: number,
): void {
  touch(cache, key, entry)
  while (cache.size > Math.max(1, maxEntries)) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) break
    cache.delete(oldest)
  }
}

function touch<T>(cache: Map<string, T>, key: string, entry: T): void {
  cache.delete(key)
  cache.set(key, entry)
}

interface SharedRequest<T> {
  controller: AbortController
  consumers: Set<symbol>
  promise: Promise<T>
  settled: boolean
}

function createSharedRequest<T>(
  controller: AbortController,
  promise: Promise<T>,
  onSettled: () => void,
): SharedRequest<T> {
  const request: SharedRequest<T> = {
    controller,
    consumers: new Set(),
    promise: Promise.resolve(undefined as T),
    settled: false,
  }
  request.promise = promise.finally(() => {
    request.settled = true
    onSettled()
  })
  void request.promise.catch(() => undefined)
  return request
}

function observeSharedRequest<T>(request: SharedRequest<T>, signal?: AbortSignal): Promise<T> {
  const consumer = Symbol('workspace-review-consumer')
  request.consumers.add(consumer)
  return new Promise<T>((resolvePromise, reject) => {
    let finished = false
    const release = () => {
      request.consumers.delete(consumer)
      if (!request.settled && request.consumers.size === 0) request.controller.abort()
    }
    const finish = (callback: () => void) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', handleAbort)
      release()
      callback()
    }
    const handleAbort = () => finish(() => reject(abortError()))
    if (signal?.aborted) {
      handleAbort()
      return
    }
    signal?.addEventListener('abort', handleAbort, { once: true })
    request.promise.then(
      (value) => finish(() => resolvePromise(value)),
      (error: unknown) => finish(() => reject(error)),
    )
  })
}

function abortError(): Error {
  const error = new Error('Workspace review request aborted.')
  error.name = 'AbortError'
  return error
}
