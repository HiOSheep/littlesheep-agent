// Resolves the first editor frame and later draft restoration from one conversation-owned draft.
import type { WorkspacePreview } from '../api'
import type { WorkspaceFileDraftState } from '../workspace-persistence'

export interface WorkspacePreviewEditorState {
  editorText: string
  savedText: string
  editing: boolean
}

/** What the pane does with this tab's stored draft after a load. */
export type WorkspaceDraftOutcome = 'persist' | 'keep' | 'drop'

export type WorkspaceTextPreview = Extract<WorkspacePreview, { kind: 'text' | 'markdown' | 'html' }>

export function isWorkspaceTextPreview(preview: WorkspacePreview | null): preview is WorkspaceTextPreview {
  return preview?.kind === 'text' || preview?.kind === 'markdown' || preview?.kind === 'html'
}

/**
 * Should the pane write, keep or drop the stored draft for the open tab?
 *
 * `keep` is the important one: while the file preview is still loading there is
 * nothing to compare the draft against, and treating that moment as "this tab has
 * no editable content" drops the draft. Measured before the fix: every stored draft
 * disappeared as soon as the panel remounted (the mount effect ran with a null
 * preview and the pane then wrote the on-disk content back), so unsaved work could
 * not survive a restart, a session switch or a reload.
 *
 * `drop` stays for the case that motivated the deletion in the first place: a
 * *loaded* preview that is genuinely not text (an image, a document) must not keep a
 * stale draft around.
 */
export function workspaceDraftOutcome(preview: WorkspacePreview | null): WorkspaceDraftOutcome {
  if (!preview) return 'keep'
  return isWorkspaceTextPreview(preview) ? 'persist' : 'drop'
}

export function resolveWorkspacePreviewEditorState(
  preview: WorkspacePreview | null,
  draft?: WorkspaceFileDraftState,
): WorkspacePreviewEditorState {
  if (!isWorkspaceTextPreview(preview) || !preview) {
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
