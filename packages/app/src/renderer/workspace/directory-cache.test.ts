import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceDirectory } from '../api'

vi.mock('../api', () => ({ listWorkspaceDirectory: vi.fn() }))

import {
  createWorkspaceDirectoryCache,
  MAX_WORKSPACE_DIRECTORY_CACHE_ENTRIES,
  WORKSPACE_DIRECTORY_CACHE_TTL_MS,
} from './directory-cache'

describe('workspace directory cache', () => {
  it('returns fresh entries without another request and refreshes stale entries', async () => {
    let now = 1_000
    const loader = vi.fn(async (root: string, path: string) => directory(root, path))
    const cache = createWorkspaceDirectoryCache({ loader, now: () => now })

    await cache.load('D:\\work', 'D:\\work')
    now += WORKSPACE_DIRECTORY_CACHE_TTL_MS
    await cache.load('D:\\work', 'D:\\work')
    expect(loader).toHaveBeenCalledOnce()

    now += 1
    await cache.load('D:\\work', 'D:\\work')
    expect(loader).toHaveBeenCalledTimes(2)
    expect(cache.read('D:\\work')['D:\\work']?.entries[0]?.name).toBe('sample.ts')
  })

  it('coalesces concurrent reads of the same directory', async () => {
    let resolveRequest!: (value: WorkspaceDirectory) => void
    const loader = vi.fn(() => new Promise<WorkspaceDirectory>((resolve) => {
      resolveRequest = resolve
    }))
    const cache = createWorkspaceDirectoryCache({ loader })

    const first = cache.load('D:\\work', 'D:\\work')
    const second = cache.load('D:\\work', 'D:\\work')
    expect(first).toBe(second)
    expect(loader).toHaveBeenCalledOnce()

    resolveRequest(directory('D:\\work', 'D:\\work'))
    await expect(first).resolves.toMatchObject({ path: 'D:\\work' })
  })

  it('retains stale snapshots across mounts while bounding cache growth', async () => {
    const cache = createWorkspaceDirectoryCache({
      loader: async (root, path) => directory(root, path),
      maxEntries: 3,
    })
    await cache.load('D:\\work', 'D:\\work')
    await cache.load('D:\\work', 'D:\\work\\a')
    await cache.load('D:\\work', 'D:\\work\\b')
    await cache.load('D:\\work', 'D:\\work\\c')

    const snapshot = cache.read('D:\\work')
    expect(Object.keys(snapshot).length).toBeLessThanOrEqual(3)
    expect(snapshot['D:\\work\\c']).toBeDefined()
    expect(MAX_WORKSPACE_DIRECTORY_CACHE_ENTRIES).toBe(128)
  })
})

function directory(root: string, path: string): WorkspaceDirectory {
  return {
    root,
    path,
    relativePath: path === root ? '' : path.slice(root.length + 1),
    entries: [{
      name: 'sample.ts',
      path: `${path}\\sample.ts`,
      relativePath: 'sample.ts',
      kind: 'file',
    }],
    truncated: false,
    hiddenCount: 0,
  }
}
