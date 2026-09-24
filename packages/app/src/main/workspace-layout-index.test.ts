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
        fileNavigatorWidth: 286.7,
        reviewNavigatorWidth: 331.2,
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
      expect(snapshot.fileNavigatorWidth).toBe(287)
      // UX-18: the review leading column survives a restart on its own value.
      expect(snapshot.reviewNavigatorWidth).toBe(331)
      expect(snapshot.openTabs).toEqual(['files', 'terminal'])
      expect(Object.keys(snapshot.drafts)).toEqual(['dirty'])

      const reloaded = new WorkspaceLayoutIndex({ dataDir: dir })
      expect(await reloaded.read()).toMatchObject({
        workspacePath: 'D:\\work',
        sessionId: 's1',
        fullscreen: true,
        fileNavigatorCollapsed: true,
        fileNavigatorWidth: 287,
        reviewNavigatorWidth: 331,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a wide responsive workspace width in the recovery mirror', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-layout-wide-'))
    try {
      const index = new WorkspaceLayoutIndex({ dataDir: dir })
      const snapshot = await index.save({
        workspacePath: 'D:\\work',
        width: 2048,
        collapsed: false,
        fullscreen: false,
        activeTab: 'review',
        openTabs: ['review'],
        openRequest: null,
        fileNavigatorCollapsed: false,
        drafts: {},
      })

      expect(snapshot.width).toBe(2048)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists and rebinds independent layout snapshots for concurrent conversations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-layout-sessions-'))
    try {
      const index = new WorkspaceLayoutIndex({ dataDir: dir })
      const firstRoot = 'D:\\work\\before'
      const secondRoot = 'D:\\work\\other'
      const firstTab = 'file:D%3A%5Cwork%5Cbefore|D%3A%5Cwork%5Cbefore%5Ca.ts'
      const secondTab = 'file:D%3A%5Cwork%5Cother|D%3A%5Cwork%5Cother%5Cb.ts'
      await Promise.all([
        index.save({
          workspacePath: firstRoot,
          sessionId: 'session-a',
          width: 480,
          collapsed: false,
          fullscreen: false,
          activeTab: firstTab,
          openTabs: [firstTab],
          openRequest: { root: firstRoot, path: `${firstRoot}\\a.ts` },
          fileNavigatorCollapsed: false,
          fileNavigatorWidth: 248,
          expandedPaths: [firstRoot, `${firstRoot}\\src`],
          drafts: {},
          browserTabs: [{
            id: 'browser:session-a',
            title: 'A',
            url: 'https://a.example/',
            history: { entries: ['https://a.example/'], index: 0 },
          }],
        }),
        index.save({
          workspacePath: secondRoot,
          sessionId: 'session-b',
          width: 520,
          collapsed: true,
          fullscreen: true,
          activeTab: secondTab,
          openTabs: [secondTab],
          openRequest: { root: secondRoot, path: `${secondRoot}\\b.ts` },
          fileNavigatorCollapsed: true,
          fileNavigatorWidth: 364,
          expandedPaths: [secondRoot],
          drafts: {},
          browserTabs: [],
        }),
      ])

      expect(await index.read('session-a')).toMatchObject({
        sessionId: 'session-a',
        activeTab: firstTab,
        fileNavigatorWidth: 248,
        expandedPaths: [firstRoot, `${firstRoot}\\src`],
      })
      expect((await index.read('session-a'))?.browserTabs?.[0]?.url).toBe('https://a.example/')
      expect(await index.read('session-b')).toMatchObject({
        sessionId: 'session-b',
        activeTab: secondTab,
        collapsed: true,
        fileNavigatorWidth: 364,
      })
      expect(await index.read(null)).toBeNull()

      const reboundRoot = 'E:\\projects\\after'
      await index.rebindWorkspace(firstRoot, reboundRoot)
      expect(await index.read('session-a')).toMatchObject({
        workspacePath: reboundRoot,
        expandedPaths: [reboundRoot, `${reboundRoot}\\src`],
      })
      expect(await index.read('session-b')).toMatchObject({ workspacePath: secondRoot })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
