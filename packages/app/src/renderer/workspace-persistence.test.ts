// @littlesheep/app — workspace-persistence.test.ts

import { describe, expect, it } from 'vitest'
import {
  adoptWorkspaceDraftSessionLayout,
  alignWorkspacePanelStateToRoot,
  buildWorkspaceRecoverySnapshot,
  hydrateWorkspaceLayoutFallbackSnapshot,
  hydrateWorkspaceFileDrafts,
  hydrateWorkspacePanelTabs,
  hydrateWorkspaceSessionLayouts,
  normalizeWorkspaceFileNavigatorWidth,
  normalizeWorkspaceSessionLayout,
  parseWorkspaceFileTabId,
  rebindWorkspacePanelState,
  rebindWorkspacePath,
  serializeWorkspaceFileDrafts,
  serializeWorkspaceSessionLayouts,
  shouldUseWorkspaceLayoutFallback,
  workspaceSessionKey,
  workspaceFileTabId,
  WORKSPACE_PANEL_OPEN_TABS_MAX,
} from './workspace-persistence'
import { LEGACY_WORKSPACE_BROWSER_TAB_ID } from './workspace/browser-tabs'

describe('workspace persistence helpers', () => {
  it('restores old navigator snapshots and bounds custom widths', () => {
    expect(normalizeWorkspaceSessionLayout({}).fileNavigatorWidth).toBe(214)
    expect(normalizeWorkspaceFileNavigatorWidth(120)).toBe(160)
    expect(normalizeWorkspaceFileNavigatorWidth(348.6)).toBe(349)
    expect(normalizeWorkspaceFileNavigatorWidth(900)).toBe(520)
  })

  it('roundtrips Windows file tab ids without losing path characters', () => {
    const root = 'D:\\tools\\Little Sheep'
    const path = 'D:\\tools\\Little Sheep\\src\\带 空格.tsx'
    const tab = workspaceFileTabId(root, path)

    expect(parseWorkspaceFileTabId(tab)).toEqual({ root, path })
    expect(parseWorkspaceFileTabId('file:not-valid')).toBeNull()
  })

  it('hydrates open tabs with legacy aliases, filtering invalid values', () => {
    const fileTab = workspaceFileTabId('D:\\work', 'D:\\work\\main.ts')

    expect(hydrateWorkspacePanelTabs(['overview', 'terminal', fileTab, 'bogus', fileTab])).toEqual([
      'review',
      'terminal',
      fileTab,
    ])
    expect(hydrateWorkspacePanelTabs(['bogus'])).toEqual(['review'])
    expect(hydrateWorkspacePanelTabs(null)).toEqual(['review'])
    expect(hydrateWorkspacePanelTabs(['files'])).toEqual(['review'])
    expect(hydrateWorkspacePanelTabs(['browser'])).toEqual([LEGACY_WORKSPACE_BROWSER_TAB_ID])
    expect(hydrateWorkspacePanelTabs([])).toEqual([])
  })

  it('bounds restored workspace tabs', () => {
    const tabs = Array.from({ length: WORKSPACE_PANEL_OPEN_TABS_MAX + 12 }, (_, index) => (
      workspaceFileTabId('D:\\work', `D:\\work\\file-${index}.ts`)
    ))

    expect(hydrateWorkspacePanelTabs(tabs)).toHaveLength(WORKSPACE_PANEL_OPEN_TABS_MAX)
  })

  it('keeps extension workspace tabs, drafts, tree paths, and browser tabs isolated by session', () => {
    const root = 'D:\\work'
    const firstFile = workspaceFileTabId(root, `${root}\\first.ts`)
    const secondFile = workspaceFileTabId(root, `${root}\\second.ts`)
    const layouts = serializeWorkspaceSessionLayouts({
      [workspaceSessionKey('session-a')]: {
        collapsed: false,
        fullscreen: false,
        activeTab: firstFile,
        openTabs: ['review', firstFile],
        openRequest: { id: 1, root, path: `${root}\\first.ts` },
        fileNavigatorCollapsed: false,
        fileNavigatorWidth: 246,
        expandedPaths: [root, `${root}\\src`],
        drafts: {
          [firstFile]: {
            path: `${root}\\first.ts`,
            editorText: 'changed-a',
            savedText: 'saved-a',
            editing: true,
          },
        },
        browserTabs: [{
          id: 'browser:session-a',
          title: 'A',
          url: 'https://a.example/',
          history: { entries: ['https://a.example/'], index: 0 },
        }],
      },
      [workspaceSessionKey('session-b')]: {
        collapsed: true,
        fullscreen: true,
        activeTab: secondFile,
        openTabs: [secondFile],
        openRequest: { id: 2, root, path: `${root}\\second.ts` },
        fileNavigatorCollapsed: true,
        fileNavigatorWidth: 318,
        expandedPaths: [`${root}\\other`],
        drafts: {},
        browserTabs: [],
      },
    })
    const restored = hydrateWorkspaceSessionLayouts(JSON.parse(JSON.stringify(layouts)))

    expect(restored[workspaceSessionKey('session-a')]).toMatchObject({
      activeTab: firstFile,
      openTabs: ['review', firstFile],
      fileNavigatorWidth: 246,
      expandedPaths: [root, `${root}\\src`],
    })
    expect(restored[workspaceSessionKey('session-a')]?.browserTabs[0]?.url).toBe('https://a.example/')
    expect(restored[workspaceSessionKey('session-a')]?.drafts[firstFile]?.editorText).toBe('changed-a')
    expect(restored[workspaceSessionKey('session-b')]).toMatchObject({
      collapsed: true,
      fullscreen: true,
      activeTab: secondFile,
      openTabs: [secondFile],
      fileNavigatorWidth: 318,
      expandedPaths: [`${root}\\other`],
    })
    expect(restored[workspaceSessionKey('session-b')]?.drafts[firstFile]).toBeUndefined()
  })

  it('adopts a persisted draft workspace when the first message creates a session', () => {
    const draftLayout = normalizeWorkspaceSessionLayout({
      collapsed: false,
      activeTab: 'terminal',
      openTabs: ['review', 'terminal'],
      expandedPaths: ['D:\\work\\src'],
    })
    const layouts = { [workspaceSessionKey()]: draftLayout }

    const adopted = adoptWorkspaceDraftSessionLayout(layouts, 'session-created-after-send')

    expect(adopted[workspaceSessionKey('session-created-after-send')]).toBe(draftLayout)
    expect(adopted[workspaceSessionKey()]).toMatchObject({
      collapsed: true,
      activeTab: 'review',
      openTabs: ['review'],
    })
    expect(layouts[workspaceSessionKey()]).toBe(draftLayout)
  })

  it('does not overwrite a session workspace that was already restored', () => {
    const draftLayout = normalizeWorkspaceSessionLayout({ activeTab: 'terminal', openTabs: ['terminal'] })
    const restoredLayout = normalizeWorkspaceSessionLayout({ activeTab: 'artifacts', openTabs: ['artifacts'] })
    const layouts = {
      [workspaceSessionKey()]: draftLayout,
      [workspaceSessionKey('session-a')]: restoredLayout,
    }

    expect(adoptWorkspaceDraftSessionLayout(layouts, 'session-a')).toBe(layouts)
    expect(layouts[workspaceSessionKey('session-a')]).toBe(restoredLayout)
  })

  it('recovers only dirty drafts that match their file tab', () => {
    const openTab = workspaceFileTabId('D:\\work', 'D:\\work\\a.ts')
    const cleanTab = workspaceFileTabId('D:\\work', 'D:\\work\\b.ts')
    const wrongPathTab = workspaceFileTabId('D:\\work', 'D:\\work\\c.ts')

    expect(hydrateWorkspaceFileDrafts({
      [openTab]: {
        path: 'D:\\work\\a.ts',
        modifiedAt: 12,
        editorText: 'changed',
        savedText: 'saved',
        editing: true,
      },
      [cleanTab]: {
        path: 'D:\\work\\b.ts',
        editorText: 'same',
        savedText: 'same',
      },
      [wrongPathTab]: {
        path: 'D:\\work\\different.ts',
        editorText: 'changed',
        savedText: 'saved',
      },
    })).toEqual({
      [openTab]: {
        path: 'D:\\work\\a.ts',
        modifiedAt: 12,
        editorText: 'changed',
        savedText: 'saved',
        editing: true,
      },
    })
  })

  it('serializes drafts only for open file tabs', () => {
    const openTab = workspaceFileTabId('D:\\work', 'D:\\work\\a.ts')
    const closedTab = workspaceFileTabId('D:\\work', 'D:\\work\\closed.ts')
    const drafts = {
      [openTab]: {
        path: 'D:\\work\\a.ts',
        editorText: 'changed',
        savedText: 'saved',
        editing: true,
      },
      [closedTab]: {
        path: 'D:\\work\\closed.ts',
        editorText: 'changed',
        savedText: 'saved',
        editing: true,
      },
    }

    expect(serializeWorkspaceFileDrafts(drafts, ['review', openTab])).toEqual({
      [openTab]: drafts[openTab],
    })
  })

  it('builds the workspace recovery summary from open tabs, open request, and dirty drafts', () => {
    const root = 'D:\\work'
    const firstTab = workspaceFileTabId(root, 'D:\\work\\a.ts')
    const secondTab = workspaceFileTabId(root, 'D:\\work\\b.ts')
    const snapshot = buildWorkspaceRecoverySnapshot({
      activeTab: secondTab,
      openTabs: ['review', firstTab, secondTab],
      openRequest: {
        id: 1,
        root,
        path: 'D:\\work\\b.ts',
      },
      drafts: {
        [firstTab]: {
          path: 'D:\\work\\a.ts',
          editorText: 'same',
          savedText: 'same',
          editing: false,
        },
        [secondTab]: {
          path: 'D:\\work\\b.ts',
          editorText: 'changed',
          savedText: 'saved',
          editing: true,
        },
      },
    })

    expect(snapshot.activeFileTab).toEqual({ tab: secondTab, root, path: 'D:\\work\\b.ts' })
    expect(snapshot.openFileTabs.map((item) => item.path)).toEqual(['D:\\work\\a.ts', 'D:\\work\\b.ts'])
    expect(snapshot.dirtyDraftCount).toBe(1)
    expect(snapshot.recentFilePath).toBe('D:\\work\\b.ts')
  })

  it('uses layout fallback only when local workspace recovery markers are missing or invalid', () => {
    expect(shouldUseWorkspaceLayoutFallback({
      width: null,
      activeTab: null,
      openTabs: null,
      openRoot: null,
      openPath: null,
      drafts: null,
    })).toBe(true)

    expect(shouldUseWorkspaceLayoutFallback({
      width: 'broken',
      activeTab: 'files',
      openTabs: 'not-json',
      openRoot: null,
      openPath: null,
      drafts: null,
    })).toBe(false)

    expect(shouldUseWorkspaceLayoutFallback({
      width: 'broken',
      activeTab: 'bad',
      openTabs: JSON.stringify(['terminal']),
      openRoot: null,
      openPath: null,
      drafts: null,
    })).toBe(false)
  })

  it('hydrates a layout mirror snapshot into recoverable workspace panel state', () => {
    const root = 'D:\\work'
    const fileTab = workspaceFileTabId(root, 'D:\\work\\a.ts')
    const staleTab = workspaceFileTabId('D:\\old', 'D:\\old\\b.ts')
    const snapshot = hydrateWorkspaceLayoutFallbackSnapshot({
      version: 1,
      updatedAt: '2026-07-10T00:00:00.000Z',
      workspacePath: root,
      sessionId: 's1',
      width: 502,
      collapsed: false,
      fullscreen: true,
      activeTab: fileTab,
      openTabs: ['files', fileTab, staleTab],
      openRequest: { root, path: 'D:\\work\\a.ts' },
      fileNavigatorCollapsed: true,
      drafts: {
        [fileTab]: {
          path: 'D:\\work\\a.ts',
          editorText: 'changed',
          savedText: 'saved',
          editing: true,
        },
        [staleTab]: {
          path: 'D:\\old\\b.ts',
          editorText: 'changed',
          savedText: 'saved',
          editing: true,
        },
      },
    })

    expect(snapshot).toMatchObject({
      workspacePath: root,
      sessionId: 's1',
      width: 502,
      collapsed: false,
      fullscreen: true,
      activeTab: fileTab,
      openTabs: ['review', fileTab],
      openRequest: { root, path: 'D:\\work\\a.ts' },
      fileNavigatorCollapsed: true,
    })
    expect(Object.keys(snapshot?.drafts ?? {})).toEqual([fileTab])
  })

  it('drops stale file state when the workspace root changes', () => {
    const currentRoot = 'D:\\work\\alpha'
    const activeFileTab = workspaceFileTabId(currentRoot, 'D:\\work\\alpha\\src\\a.ts')
    const staleFileTab = workspaceFileTabId('D:\\work\\beta', 'D:\\work\\beta\\src\\b.ts')

    const result = alignWorkspacePanelStateToRoot({
      openRequest: {
        id: 1,
        root: 'D:\\work\\beta',
        path: 'D:\\work\\beta\\src\\b.ts',
      },
      openTabs: ['terminal', activeFileTab, staleFileTab],
      activeTab: staleFileTab,
      drafts: {
        [activeFileTab]: {
          path: 'D:\\work\\alpha\\src\\a.ts',
          editorText: 'changed',
          savedText: 'saved',
          editing: true,
        },
        [staleFileTab]: {
          path: 'D:\\work\\beta\\src\\b.ts',
          editorText: 'changed',
          savedText: 'saved',
          editing: true,
        },
      },
    }, currentRoot)

    expect(result.openRequest).toBeNull()
    expect(result.openTabs).toEqual(['terminal', activeFileTab])
    expect(result.activeTab).toBe('review')
    expect(result.drafts).toEqual({
      [activeFileTab]: {
        path: 'D:\\work\\alpha\\src\\a.ts',
        editorText: 'changed',
        savedText: 'saved',
        editing: true,
      },
    })
  })

  it('does not treat sibling folders as being inside the workspace root', () => {
    const root = 'D:\\work\\app'
    const siblingTab = workspaceFileTabId('D:\\work\\app-old', 'D:\\work\\app-old\\main.ts')
    const result = alignWorkspacePanelStateToRoot({
      openRequest: null,
      openTabs: [siblingTab],
      activeTab: siblingTab,
      drafts: {},
    }, root)

    expect(result.openTabs).toEqual(['review'])
    expect(result.activeTab).toBe('review')
  })

  it('rebinds open files and dirty drafts while leaving sibling paths unchanged', () => {
    const fromRoot = 'D:\\work\\alpha'
    const toRoot = 'E:\\projects\\alpha-renamed'
    const oldFile = `${fromRoot}\\src\\index.ts`
    const oldTab = workspaceFileTabId(fromRoot, oldFile)
    const sibling = 'D:\\work\\alpha-old\\notes.md'

    const result = rebindWorkspacePanelState({
      openRequest: { id: 1, root: fromRoot, path: oldFile },
      openTabs: ['review', oldTab],
      activeTab: oldTab,
      drafts: {
        [oldTab]: { path: oldFile, editorText: 'changed', savedText: 'saved', editing: true },
      },
    }, fromRoot, toRoot)

    const newFile = `${toRoot}\\src\\index.ts`
    const newTab = workspaceFileTabId(toRoot, newFile)
    expect(result).toMatchObject({
      openRequest: { root: toRoot, path: newFile },
      openTabs: ['review', newTab],
      activeTab: newTab,
    })
    expect(result.drafts[newTab]?.path).toBe(newFile)
    expect(rebindWorkspacePath(sibling, fromRoot, toRoot)).toBe(sibling)
  })
})
