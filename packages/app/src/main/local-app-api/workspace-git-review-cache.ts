// Binds file diffs to bounded Main-process snapshots and limits Git process fan-out.

import { resolve } from 'node:path'
import type {
  WorkspaceReviewFileDiff,
  WorkspaceReviewSnapshot,
} from '../../shared/workspace-review-contracts.js'
import { HttpError } from './http.js'
import {
  readWorkspaceReviewDiffFromSnapshot,
  readWorkspaceReviewSnapshotRecord,
  type WorkspaceReviewReadOptions,
  type WorkspaceReviewSnapshotRecord,
} from './workspace-git-review.js'

export const MAX_MAIN_WORKSPACE_REVIEW_SNAPSHOTS = 8
export const MAX_MAIN_WORKSPACE_REVIEW_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const MAIN_WORKSPACE_REVIEW_SNAPSHOT_TTL_MS = 5_000
export const MAX_CONCURRENT_WORKSPACE_REVIEW_SNAPSHOTS = 2
export const MAX_CONCURRENT_WORKSPACE_REVIEW_DIFFS = 2

interface SnapshotEntry {
  record: WorkspaceReviewSnapshotRecord
  updatedAt: number
}

interface SharedRequest<T> {
  controller: AbortController
  consumers: Set<symbol>
  promise: Promise<T>
  settled: boolean
}

interface WorkspaceGitReviewCacheOptions {
  maxConcurrentSnapshots?: number
  maxConcurrentDiffs?: number
  maxSnapshotBytes?: number
  maxSnapshots?: number
  now?: () => number
  readDiff?: (
    record: WorkspaceReviewSnapshotRecord,
    targetPath: string,
    options: WorkspaceReviewReadOptions,
  ) => Promise<WorkspaceReviewFileDiff>
  readSnapshotRecord?: (
    workspacePath: string,
    options: WorkspaceReviewReadOptions,
  ) => Promise<WorkspaceReviewSnapshotRecord>
  snapshotTtlMs?: number
}

export interface WorkspaceGitReviewCache {
  readSnapshot: (
    workspacePath: string,
    options?: WorkspaceReviewReadOptions & { force?: boolean },
  ) => Promise<WorkspaceReviewSnapshot>
  readDiff: (
    workspacePath: string,
    targetPath: string,
    revision: string,
    options?: WorkspaceReviewReadOptions,
  ) => Promise<WorkspaceReviewFileDiff>
}

export function createWorkspaceGitReviewCache(
  options: WorkspaceGitReviewCacheOptions = {},
): WorkspaceGitReviewCache {
  const maxSnapshots = Math.max(1, options.maxSnapshots ?? MAX_MAIN_WORKSPACE_REVIEW_SNAPSHOTS)
  const maxSnapshotBytes = Math.max(
    1,
    options.maxSnapshotBytes ?? MAX_MAIN_WORKSPACE_REVIEW_SNAPSHOT_BYTES,
  )
  const snapshotTtlMs = Math.max(0, options.snapshotTtlMs ?? MAIN_WORKSPACE_REVIEW_SNAPSHOT_TTL_MS)
  const now = options.now ?? Date.now
  const readSnapshotRecord = options.readSnapshotRecord ?? readWorkspaceReviewSnapshotRecord
  const readDiff = options.readDiff ?? readWorkspaceReviewDiffFromSnapshot
  const snapshots = new Map<string, SnapshotEntry>()
  const snapshotRequests = new Map<string, SharedRequest<WorkspaceReviewSnapshot>>()
  const diffRequests = new Map<string, SharedRequest<WorkspaceReviewFileDiff>>()
  const runSnapshot = createAsyncLimiter(
    Math.max(1, options.maxConcurrentSnapshots ?? MAX_CONCURRENT_WORKSPACE_REVIEW_SNAPSHOTS),
  )
  const runDiff = createAsyncLimiter(
    Math.max(1, options.maxConcurrentDiffs ?? MAX_CONCURRENT_WORKSPACE_REVIEW_DIFFS),
  )

  async function readSnapshot(
    workspacePath: string,
    readOptions: WorkspaceReviewReadOptions & { force?: boolean } = {},
  ): Promise<WorkspaceReviewSnapshot> {
    const root = resolve(workspacePath)
    const key = comparablePath(root)
    const cached = snapshots.get(key)
    if (cached && !readOptions.force && now() - cached.updatedAt <= snapshotTtlMs) {
      touch(snapshots, key, cached)
      return cached.record.snapshot
    }
    return shareRequest(snapshotRequests, key, readOptions.signal, (signal) => runSnapshot(signal, async () => {
      const record = await readSnapshotRecord(root, { signal })
      const previousRevision = snapshots.get(key)?.record.snapshot.revision
      storeSnapshot(
        snapshots,
        key,
        { record, updatedAt: now() },
        maxSnapshots,
        maxSnapshotBytes,
        (evictedKey) => abortDiffRequests(diffRequests, evictedKey),
      )
      if (previousRevision && previousRevision !== record.snapshot.revision) {
        abortDiffRequests(diffRequests, key, record.snapshot.revision)
      }
      return record.snapshot
    }))
  }

  async function readFileDiff(
    workspacePath: string,
    targetPath: string,
    revision: string,
    readOptions: WorkspaceReviewReadOptions = {},
  ): Promise<WorkspaceReviewFileDiff> {
    const root = resolve(workspacePath)
    const rootKey = comparablePath(root)
    const entry = snapshots.get(rootKey)
    if (!entry || entry.record.snapshot.revision !== revision) throw staleRevisionError()
    touch(snapshots, rootKey, entry)
    const requestKey = `${rootKey}\u0000${revision}\u0000${comparablePath(resolve(targetPath))}`
    try {
      return await shareRequest(diffRequests, requestKey, readOptions.signal, (signal) => runDiff(signal, async () => {
        const current = snapshots.get(rootKey)
        if (!current || current.record.snapshot.revision !== revision) throw staleRevisionError()
        return readDiff(current.record, targetPath, { signal })
      }))
    } catch (error) {
      if (
        error instanceof Error
        && error.name === 'AbortError'
        && !readOptions.signal?.aborted
        && snapshots.get(rootKey)?.record.snapshot.revision !== revision
      ) {
        throw staleRevisionError()
      }
      throw error
    }
  }

  return { readSnapshot, readDiff: readFileDiff }
}

function shareRequest<T>(
  requests: Map<string, SharedRequest<T>>,
  key: string,
  signal: AbortSignal | undefined,
  factory: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let request = requests.get(key)
  if (!request) {
    const controller = new AbortController()
    request = {
      controller,
      consumers: new Set(),
      promise: Promise.resolve(undefined as T),
      settled: false,
    }
    const current = request
    current.promise = factory(controller.signal).finally(() => {
      current.settled = true
      if (requests.get(key) === current) requests.delete(key)
    })
    void current.promise.catch(() => undefined)
    requests.set(key, current)
  }
  return observeSharedRequest(request, signal)
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

function createAsyncLimiter(maxConcurrent: number) {
  let active = 0
  const queue: Array<() => void> = []
  const pump = () => {
    while (active < maxConcurrent && queue.length > 0) queue.shift()!()
  }
  return function run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolvePromise, reject) => {
      let started = false
      const start = () => {
        signal.removeEventListener('abort', handleAbort)
        if (signal.aborted) {
          reject(abortError())
          pump()
          return
        }
        started = true
        active += 1
        operation().then(resolvePromise, reject).finally(() => {
          active -= 1
          pump()
        })
      }
      const handleAbort = () => {
        if (started) return
        const index = queue.indexOf(start)
        if (index >= 0) queue.splice(index, 1)
        reject(abortError())
      }
      signal.addEventListener('abort', handleAbort, { once: true })
      queue.push(start)
      pump()
    })
  }
}

function storeSnapshot(
  snapshots: Map<string, SnapshotEntry>,
  key: string,
  entry: SnapshotEntry,
  maxEntries: number,
  maxBytes: number,
  onEvict: (key: string) => void,
): void {
  touch(snapshots, key, entry)
  let totalBytes = snapshotBytes(snapshots)
  while (snapshots.size > maxEntries || totalBytes > maxBytes) {
    const oldest = snapshots.keys().next().value as string | undefined
    if (!oldest) break
    const oldestEntry = snapshots.get(oldest)
    if (!oldestEntry) break
    snapshots.delete(oldest)
    totalBytes = Math.max(0, totalBytes - estimateSnapshotRecordBytes(oldestEntry.record))
    onEvict(oldest)
  }
}

function snapshotBytes(snapshots: Map<string, SnapshotEntry>): number {
  let bytes = 0
  for (const entry of snapshots.values()) bytes += estimateSnapshotRecordBytes(entry.record)
  return bytes
}

export function estimateSnapshotRecordBytes(record: WorkspaceReviewSnapshotRecord): number {
  const snapshot = record.snapshot
  let bytes = 1_024
    + stringBytes(snapshot.revision)
    + stringBytes(snapshot.workspacePath)
    + stringBytes(snapshot.repositoryRoot)
    + stringBytes(snapshot.branch)
    + stringBytes(snapshot.upstream)
    + stringBytes(snapshot.generatedAt)
    + stringBytes(snapshot.message)
  for (const file of snapshot.files) {
    bytes += 256
      + stringBytes(file.path)
      + stringBytes(file.absolutePath)
      + stringBytes(file.oldPath)
  }
  return bytes
}

function stringBytes(value: string | undefined): number {
  return (value?.length ?? 0) * 2
}

function abortDiffRequests<T>(
  requests: Map<string, SharedRequest<T>>,
  rootKey: string,
  retainedRevision?: string,
): void {
  const retainedPrefix = retainedRevision ? `${rootKey}\u0000${retainedRevision}\u0000` : ''
  for (const [key, request] of requests) {
    if (key.startsWith(`${rootKey}\u0000`) && (!retainedPrefix || !key.startsWith(retainedPrefix))) {
      request.controller.abort()
    }
  }
}

function touch<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key)
  cache.set(key, value)
}

function comparablePath(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase('en-US') : path
}

function staleRevisionError(): HttpError {
  return new HttpError(409, 'Git 更改已刷新，请基于最新审阅快照重试。')
}

function abortError(): Error {
  const error = new Error('Git review request aborted.')
  error.name = 'AbortError'
  return error
}

export const workspaceGitReviewCache = createWorkspaceGitReviewCache()
