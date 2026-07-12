import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'

describe('WorkspaceLayoutIndex', () => {
  it('persists an auditable workspace layout snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-layout-'))
    try {
      const index = new WorkspaceLayoutIndex({ dataDir: dir })
      const snapshot = await index.save({
        workspacePath: 'D:\\work',
        sessionId: 's1',
        width: 512.4,
        collapsed: false,
        fullscreen: true,
        activeTab: 'file:D%3A%5Cwork|D%3A%5Cwork%5Ca.ts',
        openTabs: ['files', 'files', 'terminal'],
        openRequest: { root: 'D:\\work', path: 'D:\\work\\a.ts' },
        fileNavigatorCollapsed: true,
        drafts: {
          dirty: {
            path: 'D:\\work\\a.ts',
            editorText: 'changed',
            savedText: 'saved',
            editing: true,
          },
          clean: {
            path: 'D:\\work\\b.ts',
            editorText: 'same',
            savedText: 'same',
          },
        },
      })

      expect(snapshot.width).toBe(512)
      expect(snapshot.openTabs).toEqual(['files', 'terminal'])
      expect(Object.keys(snapshot.drafts)).toEqual(['dirty'])

      const reloaded = new WorkspaceLayoutIndex({ dataDir: dir })
      expect(await reloaded.read()).toMatchObject({
        workspacePath: 'D:\\work',
        sessionId: 's1',
        fullscreen: true,
        fileNavigatorCollapsed: true,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
