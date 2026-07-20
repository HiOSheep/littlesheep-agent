import type { WorkspacePanelTab } from '../workspace-persistence'

export type WorkspaceEntrySelection =
  | { kind: 'open-tab'; tab: WorkspacePanelTab }
  | { kind: 'new-browser-tab'; url: '' }

// The browser entry is an add action. Existing browser tabs are activated by
// clicking their tab directly, so the entry must not resurrect a persisted URL.
export function resolveWorkspaceEntrySelection(tab: WorkspacePanelTab): WorkspaceEntrySelection {
  return tab === 'browser'
    ? { kind: 'new-browser-tab', url: '' }
    : { kind: 'open-tab', tab }
}
