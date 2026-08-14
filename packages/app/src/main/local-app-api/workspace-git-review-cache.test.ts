import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceReviewFile,
  WorkspaceReviewFileDiff,
} from '../../shared/workspace-review-contracts.js'
import { HttpError } from './http.js'
import {
  createWorkspaceGitReviewCache,
  MAX_CONCURRENT_WORKSPACE_REVIEW_DIFFS,
  MAX_CONCURRENT_WORKSPACE_REVIEW_SNAPSHOTS,
  MAX_MAIN_WORKSPACE_REVIEW_SNAPSHOT_BYTES,
  MAX_MAIN_WORKSPACE_REVIEW_SNAPSHOTS,
} from './workspace-git-review-cache.js'
import type { WorkspaceReviewSnapshotRecord } from './workspace-git-review.js'

describe('Main workspace Git review cache', () => {
  it('coalesces snapshot scans, reuses the short cache, and honors force refresh', async () => {
    let revision = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolvePromise) => { releaseFirst = resolvePromise })
    const readSnapshotRecord = vi.fn(async (workspacePath: string) => {
      revision += 1
      if (revision === 1) await firstGate
      return record(workspacePath, `r${revision}`)
    })
    const cache = createWorkspaceGitReviewCache({ readSnapshotRecord })

    const first = cache.readSnapshot('D:/work')
    const second = cache.readSnapshot('D:/work')
    releaseFirst()

    expect((await first).revision).toBe('r1')
    expect((await second).revision).toBe('r1')
    expect((await cache.readSnapshot('D:/work')).revision).toBe('r1')
    expect((await cache.readSnapshot('D:/work', { force: true })).revision).toBe('r2')
    expect(readSnapshotRecord).toHaveBeenCalledTimes(2)
  })

  it('binds details to the current snapshot and rejects stale revisions', async () => {
    let revision = 'r1'
    const readSnapshotRecord = vi.fn(async (workspacePath: string) => record(workspacePath, revision))
    const readDiff = vi.fn(async (snapshotRecord: WorkspaceReviewSnapshotRecord) => (
      diff(snapshotRecord.snapshot.revision)
    ))
    const cache = createWorkspaceGitReviewCache({ readSnapshotRecord, readDiff })

    const first = await cache.readSnapshot('D:/work')
    expect((await cache.readDiff('D:/work', 'sample.ts', first.revision)).revision).toBe('r1')
    revision = 'r2'
    await cache.readSnapshot('D:/work', { force: true })

    await expect(cache.readDiff('D:/work', 'sample.ts', 'r1'))
      .rejects.toMatchObject({ status: 409 } satisfies Partial<HttpError>)
    expect(readDiff).toHaveBeenCalledTimes(1)
  })

  it('limits concurrent detail work while allowing all queued files to complete', async () => {
    let active = 0
    let peak = 0
    const gates: Array<() => void> = []
    const readDiff = vi.fn(async (snapshotRecord: WorkspaceReviewSnapshotRecord, targetPath: string) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolvePromise) => gates.push(resolvePromise))
      active -= 1
      return diff(snapshotRecord.snapshot.revision, targetPath)
    })
    const cache = createWorkspaceGitReviewCache({
      maxConcurrentDiffs: MAX_CONCURRENT_WORKSPACE_REVIEW_DIFFS,
      readDiff,
      readSnapshotRecord: async (workspacePath) => record(workspacePath, 'r1'),
    })
    await cache.readSnapshot('D:/work')

    const requests = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => (
      cache.readDiff('D:/work', path, 'r1')
    ))
    await waitUntil(() => gates.length === 2)
    gates.splice(0, 2).forEach((release) => release())
    await waitUntil(() => gates.length === 2)
    gates.splice(0, 2).forEach((release) => release())

    await expect(Promise.all(requests)).resolves.toHaveLength(4)
    expect(peak).toBe(MAX_CONCURRENT_WORKSPACE_REVIEW_DIFFS)
  })

  it('limits concurrent snapshot scans across workspaces', async () => {
    let active = 0
    let peak = 0
    const gates: Array<() => void> = []
    const cache = createWorkspaceGitReviewCache({
      maxConcurrentSnapshots: MAX_CONCURRENT_WORKSPACE_REVIEW_SNAPSHOTS,
      readSnapshotRecord: async (workspacePath) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolvePromise) => gates.push(resolvePromise))
        active -= 1
        return record(workspacePath, workspacePath)
      },
    })
    const requests = ['a', 'b', 'c', 'd'].map((name) => cache.readSnapshot(`D:/${name}`))

    await waitUntil(() => gates.length === 2)
    gates.splice(0, 2).forEach((release) => release())
    await waitUntil(() => gates.length === 2)
    gates.splice(0, 2).forEach((release) => release())

    await expect(Promise.all(requests)).resolves.toHaveLength(4)
    expect(peak).toBe(MAX_CONCURRENT_WORKSPACE_REVIEW_SNAPSHOTS)
  })

  it('keeps Main snapshot storage bounded', async () => {
    const readSnapshotRecord = vi.fn(async (workspacePath: string) => record(workspacePath, workspacePath))
    const cache = createWorkspaceGitReviewCache({ readSnapshotRecord })
    const roots = Array.from(
      { length: MAX_MAIN_WORKSPACE_REVIEW_SNAPSHOTS + 1 },
      (_, index) => `D:/work-${index}`,
    )
    for (const root of roots) await cache.readSnapshot(root)

    await expect(cache.readDiff(roots[0]!, 'sample.ts', roots[0]!))
      .rejects.toMatchObject({ status: 409 } satisfies Partial<HttpError>)
  })

  it('evicts the oldest snapshot before the byte budget grows unbounded', async () => {
    const cache = createWorkspaceGitReviewCache({
      maxSnapshotBytes: 3_000,
      readSnapshotRecord: async (workspacePath) => record(workspacePath, workspacePath, 4),
    })
    await cache.readSnapshot('D:/first')
    await cache.readSnapshot('D:/second')

    await expect(cache.readDiff('D:/first', 'sample-0.ts', 'D:/first'))
      .rejects.toMatchObject({ status: 409 } satisfies Partial<HttpError>)
    expect(MAX_MAIN_WORKSPACE_REVIEW_SNAPSHOT_BYTES).toBe(8 * 1024 * 1024)
  })
})

function record(
  workspacePath: string,
  revision: string,
  fileCount = 1,
): WorkspaceReviewSnapshotRecord {
  const root = resolve(workspacePath)
  const files = Array.from({ length: fileCount }, (_, index) => file(root, `sample-${index}.ts`))
  return {
    snapshot: {
      revision,
      availability: 'ready',
      workspacePath: root,
      repositoryRoot: root,
      branch: 'main',
      ahead: 0,
      behind: 0,
      additions: fileCount,
      deletions: 0,
      countsComplete: true,
      totalFiles: fileCount,
      filesTruncated: false,
      files,
      generatedAt: revision,
    },
    repository: {
      repositoryRoot: root,
      scopePathspec: '.',
      scopePrefix: '',
    },
    filterOverrides: [],
  }
}

function file(root: string, path = 'sample.ts'): WorkspaceReviewFile {
  return {
    path,
    absolutePath: resolve(root, path),
    status: 'modified',
    additions: 1,
    deletions: 0,
    countAvailable: true,
    staged: false,
    unstaged: true,
    binary: false,
  }
}

function diff(revision: string, targetPath = 'sample.ts'): WorkspaceReviewFileDiff {
  const root = resolve('D:/work')
  return {
    revision,
    workspacePath: root,
    repositoryRoot: root,
    file: { ...file(root), path: targetPath, absolutePath: resolve(root, targetPath) },
    layers: [],
    hunks: [],
    binary: false,
    truncated: false,
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0))
  }
  throw new Error('Timed out waiting for queued review work.')
}
