// Resolves the first editor frame and later draft restoration from one conversation-owned draft.
import type { WorkspacePreview } from '../api'
import type { WorkspaceFileDraftState } from '../workspace-persistence'

export interface WorkspacePreviewEditorState {
  editorText: string
  savedText: string
  editing: boolean
}

export function resolveWorkspacePreviewEditorState(
  preview: WorkspacePreview | null,
  draft?: WorkspaceFileDraftState,
): WorkspacePreviewEditorState {
  if (!preview || (preview.kind !== 'text' && preview.kind !== 'markdown')) {
    return { editorText: '', savedText: '', editing: false }
  }
  if (draft?.path === preview.path && draft.modifiedAt === preview.modifiedAt) {
    return {
      editorText: draft.editorText,
      savedText: draft.savedText,
      editing: draft.editing,
    }
  }
  return {
    editorText: preview.content,
    savedText: preview.content,
    editing: false,
  }
}
