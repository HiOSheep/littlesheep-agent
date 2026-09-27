// Workspace file-tab close bookkeeping: the session-layout transitions a file tab
// goes through while it is being closed.
//
// Split out of `use-workspace-layout-controller.ts` so that hook keeps only the
// interaction (approval, save, error wording) and this module owns the layout
// writes it commits: recording the saved version of a draft, finding the in-flight
// close of a tab, and closing a tab together with its draft.
import type { WorkspacePreview } from '../api'
import {
  DEFAULT_WORKSPACE_PANEL_TABS,
  parseWorkspaceFileTabId,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId,
  type WorkspacePanelTabId,
  type WorkspaceSessionLayout,
  type WorkspaceSessionLayouts,
} from '../workspace-persistence'
import { isWorkspaceBrowserTabId } from './browser-tabs'
import type { ClosingWorkspaceFileState } from './use-workspace-session-layouts'

type WorkspaceSessionFileDraftsUpdater = (
  layoutKey: string,
  update: (drafts: Record<string, WorkspaceFileDraftState>) => Record<string, WorkspaceFileDraftState>,
) => void

export function findClosingWorkspaceFileState(
  closingTabs: Map<string, ClosingWorkspaceFileState>,
  layoutKey: string,
  tab: WorkspaceFileTabId,
): ClosingWorkspaceFileState | undefined {
  for (const state of closingTabs.values()) {
    if (state.layoutKey === layoutKey && state.fileTabId === tab) return state
  }
  return undefined
}

export function recordSavedWorkspaceFileDraft(
  setWorkspaceSessionFileDrafts: WorkspaceSessionFileDraftsUpdater,
  layoutKey: string,
  tab: WorkspaceFileTabId,
  savedText: string,
  preview: WorkspacePreview,
  closingState: {
    hasSavedVersion: boolean
    savedText: string
    modifiedAt?: number
  },
): WorkspaceFileDraftState | undefined {
  closingState.hasSavedVersion = true
  closingState.savedText = savedText
  closingState.modifiedAt = preview.modifiedAt

  let recordedDraft: WorkspaceFileDraftState | undefined
  setWorkspaceSessionFileDrafts(layoutKey, (drafts) => {
    const currentDraft = drafts[tab]
    if (!currentDraft) return drafts
    recordedDraft = {
      ...currentDraft,
      modifiedAt: preview.modifiedAt,
      savedText,
    }
    return { ...drafts, [tab]: recordedDraft }
  })
  return recordedDraft
}

/**
 * Close a tab and, for a file tab, drop its draft with it.
 *
 * The two belong together on purpose: an unsaved draft lives in the layout entry
 * of its tab, so a tab that leaves the layout cannot leave a draft behind that a
 * later save would write. Every path that closes a file tab (clean close, saved
 * close, and the explicit 放弃修改 answer) goes through here.
 */
export function finalizeWorkspacePanelTabClose(
  workspaceSessionLayoutsRef: { current: WorkspaceSessionLayouts },
  commitWorkspaceSessionLayout: (layoutKey: string, layout: WorkspaceSessionLayout) => void,
  layoutKey: string,
  tab: WorkspacePanelTabId,
): void {
  const layout = workspaceSessionLayoutsRef.current[layoutKey]
  if (!layout) return
  const currentTabs = layout.openTabs
  const tabIndex = currentTabs.indexOf(tab)
  const nextTabs = currentTabs.filter((item) => item !== tab)
  const browserTabs = isWorkspaceBrowserTabId(tab)
    ? layout.browserTabs.filter((item) => item.id !== tab)
    : layout.browserTabs
  let drafts = layout.drafts
  if (parseWorkspaceFileTabId(tab)) {
    if (drafts[tab]) {
      const next = { ...drafts }
      delete next[tab]
      drafts = next
    }
  }
  if (tabIndex < 0) {
    if (browserTabs !== layout.browserTabs || drafts !== layout.drafts) {
      commitWorkspaceSessionLayout(layoutKey, { ...layout, browserTabs, drafts })
    }
    return
  }
  let activeTab = layout.activeTab
  let collapsed = layout.collapsed
  if (nextTabs.length === 0) {
    activeTab = DEFAULT_WORKSPACE_PANEL_TABS[0] ?? 'review'
    collapsed = false
  } else if (activeTab === tab) {
    activeTab = nextTabs[Math.max(0, tabIndex - 1)] ?? nextTabs[0] ?? 'review'
  }
  commitWorkspaceSessionLayout(layoutKey, {
    ...layout,
    activeTab,
    openTabs: nextTabs,
    collapsed,
    drafts,
    browserTabs,
  })
}
