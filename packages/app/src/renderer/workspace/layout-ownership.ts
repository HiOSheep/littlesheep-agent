// Which conversation owns the layout produced before any conversation was chosen.
//
// The window is usable before the session list resolves, so a file opened in that
// window is filed under the draft bucket while the sidebar already highlights a
// conversation. These rules decide when that draft is claimed, and the measured
// shapes behind them are in the baseline document's CS-08 supplement.

import {
  DEFAULT_WORKSPACE_PANEL_TABS,
  WORKSPACE_DRAFT_SESSION_KEY,
  createDefaultWorkspaceSessionLayout,
  workspaceSessionKey,
  type WorkspaceSessionLayout,
  type WorkspaceSessionLayouts,
} from '../workspace-persistence'

/**
 * Whether a layout holds anything the user actually produced.
 *
 * Entering a conversation creates that conversation's bucket before the adoption
 * below runs, and that bucket is not empty: the switch aligns the panel and leaves
 * one expanded tree path behind. So only produced content counts - a tab beyond
 * the defaults, an open request naming a file, a draft, or a browser tab. The
 * measured shapes are in the baseline document's CS-08 supplement.
 */
export function hasWorkspaceLayoutContent(layout: WorkspaceSessionLayout | undefined): boolean {
  if (!layout) return false
  if (layout.openRequest?.path) return true
  if (Object.keys(layout.drafts).length > 0) return true
  if (layout.browserTabs.length > 0) return true
  const defaults = new Set<string>(DEFAULT_WORKSPACE_PANEL_TABS)
  return layout.openTabs.some((tab) => !defaults.has(tab))
}

/**
 * Move the unsaved conversation workspace into the session it belongs to, once.
 *
 * The window is usable before any conversation is chosen, so a file opened then is
 * filed under the draft bucket while the sidebar already highlights a
 * conversation: entering that conversation has to bring the file along. An empty
 * draft is never carried, a conversation with content of its own keeps it, and a
 * bucket that is only the default the switch just created does not block the move.
 */
export function adoptWorkspaceDraftSessionLayout(
  layouts: WorkspaceSessionLayouts,
  sessionId: string | undefined,
): WorkspaceSessionLayouts {
  const targetKey = workspaceSessionKey(sessionId)
  if (targetKey === WORKSPACE_DRAFT_SESSION_KEY) return layouts
  const draftLayout = layouts[WORKSPACE_DRAFT_SESSION_KEY]
  if (!draftLayout || !hasWorkspaceLayoutContent(draftLayout)) return layouts
  if (hasWorkspaceLayoutContent(layouts[targetKey])) return layouts
  return {
    ...layouts,
    [targetKey]: draftLayout,
    [WORKSPACE_DRAFT_SESSION_KEY]: createDefaultWorkspaceSessionLayout(),
  }
}
