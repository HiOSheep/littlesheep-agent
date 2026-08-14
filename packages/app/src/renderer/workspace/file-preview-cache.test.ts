import { describe, expect, it, vi } from 'vitest'
import type { WorkspacePreview } from '../api'

vi.mock('../api', () => ({ previewWorkspaceFile: vi.fn() }))

import {
  createWorkspaceFilePreviewCache,
  estimateWorkspacePreviewBytes,
  WORKSPACE_FILE_PREVIEW_CACHE_TTL_MS,
} from './file-preview-cache'

describe('workspace file preview cache', () => {
  it('reuses a fresh preview and coalesces a stale refresh', async () => {
    let now = 1_000
    let resolveRefresh!: (value: WorkspacePreview) => void
    const loader = vi.fn<(_root: string, _path: string) => Promise<WorkspacePreview>>(
      async () => preview('first'),
    )
    const cache = createWorkspaceFilePreviewCache({ loader, now: () => now })

    await cache.load('D:\\work', 'D:\\work\\sample.ts')
    await cache.load('D:\\work', 'D:\\work\\sample.ts')
    expect(loader).toHaveBeenCalledOnce()

    now += WORKSPACE_FILE_PREVIEW_CACHE_TTL_MS + 1
    loader.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve
    }))
    const first = cache.load('D:\\work', 'D:\\work\\sample.ts')
    const second = cache.load('D:\\work', 'D:\\work\\sample.ts')
    expect(first).toBe(second)
    expect(textContent(cache.read('D:\\work', 'D:\\work\\sample.ts'))).toBe('first')

    resolveRefresh(preview('second'))
    await first
    expect(textContent(cache.read('D:\\work', 'D:\\work\\sample.ts'))).toBe('second')
  })

  it('keeps a local save newer than an older request that finishes later', async () => {
    let resolveLoad!: (value: WorkspacePreview) => void
    const cache = createWorkspaceFilePreviewCache({
      loader: () => new Promise((resolve) => {
        resolveLoad = resolve
      }),
    })

    const loading = cache.load('D:\\work', 'D:\\work\\sample.ts')
    cache.store('D:\\work', 'D:\\work\\sample.ts', preview('saved'))
    resolveLoad(preview('stale'))

    await expect(loading).resolves.toMatchObject({ content: 'saved' })
    expect(textContent(cache.read('D:\\work', 'D:\\work\\sample.ts'))).toBe('saved')
  })

  it('evicts old previews when their estimated memory crosses the budget', async () => {
    const second = preview('second', 'second.ts')
    const maxBytes = estimateWorkspacePreviewBytes(second) + 1
    const cache = createWorkspaceFilePreviewCache({
      loader: async (_root, path) => preview(
        path.includes('first') ? 'first' : 'second',
        path.split('\\').at(-1) ?? path,
      ),
      maxBytes,
      maxEntries: 10,
    })

    await cache.load('D:\\work', 'D:\\work\\first.ts')
    await cache.load('D:\\work', 'D:\\work\\second.ts')

    expect(cache.read('D:\\work', 'D:\\work\\first.ts')).toBeNull()
    expect(cache.read('D:\\work', 'D:\\work\\second.ts')).not.toBeNull()
  })
})

function preview(content: string, name = 'sample.ts'): Extract<WorkspacePreview, { kind: 'text' }> {
  return {
    kind: 'text',
    path: `D:\\work\\${name}`,
    name,
    relativePath: name,
    size: content.length,
    modifiedAt: 1,
    language: 'typescript',
    content,
  }
}

function textContent(value: WorkspacePreview | null): string | undefined {
  return value?.kind === 'text' || value?.kind === 'markdown' ? value.content : undefined
}
