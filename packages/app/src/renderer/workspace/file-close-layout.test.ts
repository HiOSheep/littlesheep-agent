import { describe, expect, it } from 'vitest'
import {
  createDefaultWorkspaceSessionLayout,
  workspaceFileTabId,
  type WorkspaceFileDraftState,
  type WorkspaceSessionLayout,
  type WorkspaceSessionLayouts,
} from '../workspace-persistence'
import type { WorkspacePreview } from '../api'
import {
  finalizeWorkspacePanelTabClose,
  findClosingWorkspaceFileState,
  recordSavedWorkspaceFileDraft,
} from './file-close-layout'
import { createWorkspaceBrowserTab } from './browser-tabs'
import type { ClosingWorkspaceFileState } from './use-workspace-session-layouts'

const NOTES_TAB = workspaceFileTabId('D:\\workspace', 'D:\\workspace\\notes.txt')
const README_TAB = workspaceFileTabId('D:\\workspace', 'D:\\workspace\\README.md')
const LAYOUT_KEY = '__draft__'

function draft(editorText: string, savedText: string): WorkspaceFileDraftState {
  return {
    path: 'D:\\workspace\\notes.txt',
    modifiedAt: 1,
    editorText,
    savedText,
    editing: true,
  }
}

function textPreview(content: string, modifiedAt: number): WorkspacePreview {
  return {
    kind: 'text',
    path: 'D:\\workspace\\notes.txt',
    name: 'notes.txt',
    relativePath: 'notes.txt',
    size: content.length,
    modifiedAt,
    language: 'text',
    content,
  }
}

function layoutWith(overrides: Partial<WorkspaceSessionLayout>): WorkspaceSessionLayout {
  return {
    ...createDefaultWorkspaceSessionLayout(),
    collapsed: false,
    openTabs: [],
    activeTab: 'review',
    ...overrides,
  }
}

function sessionLayouts(layout: WorkspaceSessionLayout): {
  ref: { current: WorkspaceSessionLayouts }
  commits: Array<{ layoutKey: string; layout: WorkspaceSessionLayout }>
  commit: (layoutKey: string, next: WorkspaceSessionLayout) => void
} {
  const ref = { current: { [LAYOUT_KEY]: layout } as WorkspaceSessionLayouts }
  const commits: Array<{ layoutKey: string; layout: WorkspaceSessionLayout }> = []
  return {
    ref,
    commits,
    commit: (layoutKey, next) => {
      commits.push({ layoutKey, layout: next })
      ref.current = { ...ref.current, [layoutKey]: next }
    },
  }
}

describe('finalizeWorkspacePanelTabClose', () => {
  it('closes a file tab together with its unsaved draft', () => {
    const session = sessionLayouts(layoutWith({
      openTabs: [NOTES_TAB, README_TAB],
      activeTab: NOTES_TAB,
      drafts: { [NOTES_TAB]: draft('edited', 'saved') },
    }))

    finalizeWorkspacePanelTabClose(session.ref, session.commit, LAYOUT_KEY, NOTES_TAB)

    const closed = session.commits.at(-1)?.layout
    expect(closed?.openTabs).toEqual([README_TAB])
    expect(closed?.activeTab).toBe(README_TAB)
    // Nothing survives that a later save could write: this is the discard answer.
    expect(closed?.drafts).toEqual({})
    expect(session.ref.current[LAYOUT_KEY]?.drafts).toEqual({})
  })

  it('keeps the drafts of the tabs that stay open', () => {
    const session = sessionLayouts(layoutWith({
      openTabs: [NOTES_TAB, README_TAB],
      activeTab: README_TAB,
      drafts: { [NOTES_TAB]: draft('edited', 'saved') },
    }))

    finalizeWorkspacePanelTabClose(session.ref, session.commit, LAYOUT_KEY, README_TAB)

    const closed = session.commits.at(-1)?.layout
    expect(closed?.openTabs).toEqual([NOTES_TAB])
    expect(closed?.activeTab).toBe(NOTES_TAB)
    expect(closed?.drafts[NOTES_TAB]).toMatchObject({ editorText: 'edited', savedText: 'saved' })
  })

  it('drops a browser tab from its own list and only touches other session layouts when needed', () => {
    const session = sessionLayouts(layoutWith({
      openTabs: ['browser:1', 'review'],
      activeTab: 'browser:1',
      browserTabs: [createWorkspaceBrowserTab('https://example.com', 'browser:1')],
    }))

    finalizeWorkspacePanelTabClose(session.ref, session.commit, LAYOUT_KEY, 'browser:1')

    const closed = session.commits.at(-1)?.layout
    expect(closed?.openTabs).toEqual(['review'])
    expect(closed?.browserTabs).toEqual([])
    expect(closed?.activeTab).toBe('review')
  })

  it('ignores a layout key it has never seen', () => {
    const session = sessionLayouts(layoutWith({ openTabs: [NOTES_TAB] }))

    finalizeWorkspacePanelTabClose(session.ref, session.commit, 'session:missing', NOTES_TAB)

    expect(session.commits).toEqual([])
  })
})

describe('recordSavedWorkspaceFileDraft', () => {
  it('moves the saved version onto the draft and onto the closing state', () => {
    let drafts: Record<string, WorkspaceFileDraftState> = { [NOTES_TAB]: draft('edited', 'saved') }
    const closingState: Pick<ClosingWorkspaceFileState, 'hasSavedVersion' | 'savedText' | 'modifiedAt'> = {
      hasSavedVersion: false,
      savedText: '',
    }

    const recorded = recordSavedWorkspaceFileDraft(
      (_layoutKey, update) => { drafts = update(drafts) },
      LAYOUT_KEY,
      NOTES_TAB,
      'edited',
      textPreview('edited', 7),
      closingState,
    )

    expect(recorded).toMatchObject({ editorText: 'edited', savedText: 'edited', modifiedAt: 7 })
    expect(drafts[NOTES_TAB]).toMatchObject({ savedText: 'edited', modifiedAt: 7 })
    expect(closingState).toMatchObject({ hasSavedVersion: true, savedText: 'edited', modifiedAt: 7 })
  })

  it('reports nothing when the draft is gone', () => {
    const drafts: Record<string, WorkspaceFileDraftState> = {}
    const closingState = { hasSavedVersion: false, savedText: '' }

    const recorded = recordSavedWorkspaceFileDraft(
      (_layoutKey, update) => { update(drafts) },
      LAYOUT_KEY,
      NOTES_TAB,
      'edited',
      textPreview('edited', 7),
      closingState,
    )

    expect(recorded).toBeUndefined()
    expect(closingState.hasSavedVersion).toBe(true)
  })
})

describe('findClosingWorkspaceFileState', () => {
  it('matches the in-flight close by session layout and tab', () => {
    const state = { layoutKey: LAYOUT_KEY, fileTabId: NOTES_TAB, hasSavedVersion: false, savedText: '' }
    const closingTabs = new Map([[`${LAYOUT_KEY}\0${NOTES_TAB}`, state]])

    expect(findClosingWorkspaceFileState(closingTabs, LAYOUT_KEY, NOTES_TAB)).toBe(state)
    expect(findClosingWorkspaceFileState(closingTabs, 'session:other', NOTES_TAB)).toBeUndefined()
    expect(findClosingWorkspaceFileState(closingTabs, LAYOUT_KEY, README_TAB)).toBeUndefined()
  })
})
