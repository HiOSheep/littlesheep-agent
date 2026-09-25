// The one cross-surface action the HTML run controls need from the browser: reload
// the tab that is showing the running page.
//
// It travels as a window event because the two surfaces are far apart in the tree
// (HTML toolbar → workspace panel; browser tab → dock), and reloading is addressed by
// URL, not by prop identity. Only the browser whose `url` matches reacts, so a second
// browser tab on another page is untouched. Same pattern as the column-resize and
// navigator-motion events the editor layout already listens to.
export const WORKSPACE_BROWSER_RELOAD_EVENT = 'littlesheep:workspace-browser-reload'

export interface WorkspaceBrowserReloadDetail {
  /** Page to reload; the browser tab showing exactly this URL reloads itself. */
  url: string
}

/** Ask the browser tab showing `url` to reload. Returns false when the URL is empty. */
export function requestWorkspaceBrowserReload(url: string): boolean {
  if (!url.trim()) return false
  window.dispatchEvent(new CustomEvent<WorkspaceBrowserReloadDetail>(
    WORKSPACE_BROWSER_RELOAD_EVENT,
    { detail: { url } },
  ))
  return true
}
