// Reading a workspace surface again because the machine moved on.
//
// The workspace used to carry a refresh button per surface: the folder column had one, the Git review
// had one, and the file view only noticed a change when something else happened to re-read it. A
// reader who edits a file in another program (or an agent that writes one) should not have to press
// anything, so the buttons are gone and each surface re-reads itself on a tick while the window is
// visible, plus the moment it comes back into focus (asked for 2026-10-03).
//
// The tick is a poll, not a filesystem watcher: Main has no watcher, the reads it already serves are
// cheap (`/workspace/list`, `/workspace/file-stat`), and a poll only runs while the surface is on
// screen. Each surface passes its own interval, because a directory listing and a Git snapshot cost
// very different amounts.
import { useEffect, useRef } from 'react'

/** Folder column: a directory listing, cheap enough to keep current. */
export const WORKSPACE_TREE_REFRESH_MS = 4000
/** Open file: one `file-stat` probe per tick. */
export const WORKSPACE_FILE_REFRESH_MS = 4000
/** Git review: a real snapshot, so it refreshes far less often. */
export const WORKSPACE_REVIEW_REFRESH_MS = 15000

export function useWorkspaceAutoRefresh(
  refresh: () => void,
  intervalMs: number,
  enabled = true,
): void {
  // The callback is held in a ref so a surface that recreates its handler every render does not
  // restart the timer on every render.
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    if (!enabled || !Number.isFinite(intervalMs) || intervalMs <= 0) return
    const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
    const tick = () => {
      if (visible()) latest.current()
    }
    const timer = window.setInterval(tick, intervalMs)
    // Coming back to the window is the strongest hint that something outside changed.
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', tick)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [enabled, intervalMs])
}
