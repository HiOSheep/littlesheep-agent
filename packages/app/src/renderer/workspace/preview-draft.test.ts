import { describe, expect, it } from 'vitest'
import type { WorkspacePreview } from '../api'
import { resolveWorkspacePreviewEditorState } from './preview-draft'

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
})
