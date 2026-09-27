import type { WorkspacePreview } from '../api'
import {
  parseWorkspaceFileTabId,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId,
  type WorkspacePanelTabId,
} from '../workspace-persistence'
import { lastPathSegment } from './path-utils'

export type WorkspaceFileCloseResult = 'closed' | 'approval-denied'

/**
 * The user's answer once a plain close has already been refused.
 *
 * Closing a dirty file raises the *permission* prompt ("may I write this file?"),
 * whose three answers all speak about saving. `discardDraft` is the third answer
 * that prompt cannot express (VS Code's "Don't Save"): leave the file on disk
 * alone and close the tab, dropping the draft. It is only ever set by an explicit
 * click on the refusal notice's 放弃修改 action, so a denied approval still writes
 * nothing and never discards by itself.
 */
export interface WorkspaceFileCloseRequest {
  discardDraft?: boolean
}

export type WorkspaceFileTabCloseHandler = (
  tab: WorkspacePanelTabId,
  request?: WorkspaceFileCloseRequest,
) => Promise<WorkspaceFileCloseResult | undefined>

export interface WorkspaceFileCloseRefusal {
  tab: WorkspaceFileTabId
  label: string
}

/**
 * Which close result leaves something for the user to decide.
 *
 * Only a refused save approval does: the file tab stays open and dirty, and the
 * permission dialog had no answer that means "close without saving". A completed
 * close, a clean tab, or a save that failed all have their own visible outcome.
 */
export function workspaceFileCloseRefusal(
  tab: WorkspacePanelTabId,
  result: WorkspaceFileCloseResult | undefined,
): WorkspaceFileCloseRefusal | null {
  if (result !== 'approval-denied') return null
  const fileTab = parseWorkspaceFileTabId(tab)
  if (!fileTab) return null
  return { tab: tab as WorkspaceFileTabId, label: lastPathSegment(fileTab.path) }
}

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
