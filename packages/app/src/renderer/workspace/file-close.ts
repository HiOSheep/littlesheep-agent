import type { WorkspacePreview } from '../api'
import type { WorkspaceFileDraftState } from '../workspace-persistence'

export type WorkspaceFileCloseResult = 'closed' | 'approval-denied'

export interface SaveWorkspaceFileBeforeCloseOptions {
  getDraft: () => WorkspaceFileDraftState | undefined
  requestSaveApproval: () => Promise<boolean>
  saveDraft: (content: string, expectedModifiedAt?: number) => Promise<WorkspacePreview>
  recordSavedDraft: (
    savedText: string,
    preview: WorkspacePreview,
  ) => WorkspaceFileDraftState | undefined
  closeTab: () => void
}

export async function saveWorkspaceFileBeforeClose({
  getDraft,
  requestSaveApproval,
  saveDraft,
  recordSavedDraft,
  closeTab,
}: SaveWorkspaceFileBeforeCloseOptions): Promise<WorkspaceFileCloseResult> {
  const initialDraft = getDraft()
  if (!initialDraft || initialDraft.editorText === initialDraft.savedText) {
    closeTab()
    return 'closed'
  }

  if (!await requestSaveApproval()) return 'approval-denied'

  while (true) {
    const draft = getDraft()
    if (!draft || draft.editorText === draft.savedText) {
      closeTab()
      return 'closed'
    }

    const savedText = draft.editorText
    const preview = await saveDraft(savedText, draft.modifiedAt)
    const latestDraft = recordSavedDraft(savedText, preview)
    if (!latestDraft || latestDraft.editorText === latestDraft.savedText) {
      closeTab()
      return 'closed'
    }
  }
}
