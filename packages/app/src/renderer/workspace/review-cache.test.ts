import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceReviewFileDiff, WorkspaceReviewSnapshot } from '../api'

vi.mock('../api', () => ({
  getWorkspaceReview: vi.fn(),
  getWorkspaceReviewDiff: vi.fn(),
}))

import {
  createWorkspaceReviewCache,
  estimateWorkspaceReviewDiffBytes,
  MAX_WORKSPACE_REVIEW_DIFFS,
  MAX_WORKSPACE_REVIEW_DIFF_BYTES,
  MAX_WORKSPACE_REVIEW_SNAPSHOTS,
  WORKSPACE_REVIEW_CACHE_TTL_MS,
} from './review-cache'

describe('workspace review cache', () => {
  it('keeps a stale snapshot visible while one shared refresh completes', async () => {
    let now = 1_000
    let nextSnapshot = snapshot('first')
    let resolveRefresh!: (value: WorkspaceReviewSnapshot) => void
    const loadSnapshot = vi.fn(async () => nextSnapshot)
    const cache = createWorkspaceReviewCache({ loadSnapshot, now: () => now })

    await cache.loadSnapshot('D:\\work')
    now += WORKSPACE_REVIEW_CACHE_TTL_MS + 1
    loadSnapshot.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve
    }))
    const first = cache.loadSnapshot('D:\\work')
    const second = cache.loadSnapshot('D:\\work')

    expect(loadSnapshot).toHaveBeenCalledTimes(2)
    expect(cache.readSnapshot('D:\\work')?.generatedAt).toBe('first')
    resolveRefresh(snapshot('second'))
    await expect(Promise.all([first, second])).resolves.toEqual([snapshot('second'), snapshot('second')])
    expect(cache.readSnapshot('D:\\work')?.generatedAt).toBe('second')
  })

  it('keys file diffs by snapshot revision and reuses matching content', async () => {
    const loadDiff = vi.fn(async () => diff())
    const cache = createWorkspaceReviewCache({ loadDiff })

    await cache.loadDiff('D:\\work', 'src/sample.ts', 'revision-1')
    await cache.loadDiff('D:\\work', 'src/sample.ts', 'revision-1')
    await cache.loadDiff('D:\\work', 'src/sample.ts', 'revision-2')

    expect(loadDiff).toHaveBeenCalledTimes(2)
    expect(cache.readDiff('D:\\work', 'src/sample.ts', 'revision-1')).not.toBeNull()
    expect(MAX_WORKSPACE_REVIEW_SNAPSHOTS).toBe(8)
    expect(MAX_WORKSPACE_REVIEW_DIFFS).toBe(32)
    expect(MAX_WORKSPACE_REVIEW_DIFF_BYTES).toBe(20 * 1024 * 1024)
  })

  it('aborts a detail request after its final consumer leaves', async () => {
    let observedSignal: AbortSignal | undefined
    const loadDiff = vi.fn((_root, _path, _revision, options) => {
      observedSignal = options?.signal
      return new Promise<WorkspaceReviewFileDiff>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    })
    const cache = createWorkspaceReviewCache({ loadDiff })
    const controller = new AbortController()
    const request = cache.loadDiff('D:\\work', 'sample.ts', 'r1', { signal: controller.signal })

    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(observedSignal?.aborted).toBe(true)
  })

  it('evicts old diffs when the byte budget is reached', async () => {
    const first = diff('first')
    const second = diff('second')
    const cache = createWorkspaceReviewCache({
      loadDiff: async (_root, path) => path.includes('first') ? first : second,
      maxDiffBytes: estimateWorkspaceReviewDiffBytes(second) + 1,
      maxDiffs: 32,
    })

    await cache.loadDiff('D:\\work', 'first.ts', 'r1')
    await cache.loadDiff('D:\\work', 'second.ts', 'r1')

    expect(cache.readDiff('D:\\work', 'first.ts', 'r1')).toBeNull()
    expect(cache.readDiff('D:\\work', 'second.ts', 'r1')).not.toBeNull()
  })
})

function snapshot(generatedAt: string): WorkspaceReviewSnapshot {
  return {
    revision: generatedAt,
    availability: 'ready',
    workspacePath: 'D:\\work',
    repositoryRoot: 'D:\\work',
    branch: 'main',
    ahead: 0,
    behind: 0,
    additions: 1,
    deletions: 0,
    countsComplete: true,
    totalFiles: 1,
    filesTruncated: false,
    files: [diff().file],
    generatedAt,
  }
}

function diff(name = 'sample'): WorkspaceReviewFileDiff {
  return {
    revision: 'revision-1',
    workspacePath: 'D:\\work',
    repositoryRoot: 'D:\\work',
    file: {
      path: `src/${name}.ts`,
      absolutePath: `D:\\work\\src\\${name}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      countAvailable: true,
      staged: false,
      unstaged: true,
      binary: false,
    },
    layers: [],
    hunks: [],
    binary: false,
    truncated: false,
  }
}
