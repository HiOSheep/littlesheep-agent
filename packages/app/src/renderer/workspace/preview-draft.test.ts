import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { WorkspacePreview } from '../api'
import { resolveWorkspacePreviewEditorState, workspaceDraftOutcome } from './preview-draft'

describe('workspace preview draft restoration', () => {
  const preview: WorkspacePreview = {
    kind: 'text',
    path: 'D:\\work\\same.ts',
    name: 'same.ts',
    relativePath: 'same.ts',
    size: 12,
    modifiedAt: 42,
    language: 'typescript',
    content: 'saved',
  }

  it('resolves different first-frame editor state for the same file in two conversations', () => {
    const sessionA = resolveWorkspacePreviewEditorState(preview, {
      path: preview.path,
      modifiedAt: preview.modifiedAt,
      editorText: 'draft-a',
      savedText: 'saved',
      editing: true,
    })
    const sessionB = resolveWorkspacePreviewEditorState(preview, {
      path: preview.path,
      modifiedAt: preview.modifiedAt,
      editorText: 'draft-b',
      savedText: 'saved',
      editing: false,
    })

    expect(sessionA).toEqual({ editorText: 'draft-a', savedText: 'saved', editing: true })
    expect(sessionB).toEqual({ editorText: 'draft-b', savedText: 'saved', editing: false })
  })

  it('rejects a draft from another file revision', () => {
    expect(resolveWorkspacePreviewEditorState(preview, {
      path: preview.path,
      modifiedAt: 41,
      editorText: 'stale',
      savedText: 'saved',
      editing: true,
    })).toEqual({ editorText: 'saved', savedText: 'saved', editing: false })
  })

  it('keeps a stored draft while the preview is still loading', () => {
    // The mount effect runs before the file has loaded. Treating that moment as
    // "nothing editable here" deleted every stored draft on remount, so unsaved work
    // could not survive a restart, a session switch or a reload (measured).
    expect(workspaceDraftOutcome(null)).toBe('keep')
  })

  it('persists the draft for every editable kind and drops it for a loaded non-text preview', () => {
    expect(workspaceDraftOutcome(preview)).toBe('persist')
    expect(workspaceDraftOutcome({ ...preview, kind: 'markdown' } as WorkspacePreview)).toBe('persist')
    expect(workspaceDraftOutcome({ ...preview, kind: 'html' } as WorkspacePreview)).toBe('persist')
    expect(workspaceDraftOutcome({
      kind: 'image',
      path: preview.path,
      name: 'shot.png',
      relativePath: 'shot.png',
      size: 10,
    })).toBe('drop')
  })

  it('is the rule the pane follows, not an inline condition', async () => {
    const pane = await readFile(new URL('./preview-pane.tsx', import.meta.url), 'utf8')

    expect(pane).toContain('const outcome = workspaceDraftOutcome(preview)')
    expect(pane).toContain("if (outcome === 'persist' && editable && preview && tabId && onDraftChange)")
    expect(pane).toContain("} else if (outcome === 'drop' && tabId && onDraftChange) {")
    // The bug was a bare `else`: no preview at all must never delete the draft.
    expect(pane).not.toContain('} else {\n      if (tabId && onDraftChange) onDraftChange(tabId, null)')
  })
})
