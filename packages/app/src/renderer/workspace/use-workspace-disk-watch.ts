// Watch the open file on disk while the pane is editing it (UX-25 item 3).
//
// The check is metadata only (Main returns exists/mtimeMs), so a slow poll is cheap;
// the pane is told the version it loaded, and this hook answers "is that still what is
// on disk?" so the user hears about an external change before a save fails with 409.
import { useEffect, useRef, useState } from 'react'
import { statWorkspaceFile } from '../api/workspace'
import { workspaceDiskState, type WorkspaceDiskState } from './preview-disk-state'

/** Five seconds: fast enough to notice a change while typing, cheap enough to ignore. */
const DISK_POLL_INTERVAL_MS = 5000

export function useWorkspaceDiskWatch({
  root,
  path,
  loadedModifiedAt,
  enabled,
  revision,
}: {
  root: string
  path: string
  /** The mtime of the version the pane is showing (undefined until it loads). */
  loadedModifiedAt: number | undefined
  enabled: boolean
  /** Bump to re-check immediately (e.g. after a save or a reload from disk). */
  revision: number
}): WorkspaceDiskState {
  const [state, setState] = useState<WorkspaceDiskState>('unknown')
  const loadedRef = useRef(loadedModifiedAt)
  loadedRef.current = loadedModifiedAt

  useEffect(() => {
    if (!enabled || !root || !path) {
      setState('unknown')
      return
    }
    let cancelled = false
    const check = async () => {
      try {
        const result = await statWorkspaceFile(root, path)
        if (cancelled) return
        setState(workspaceDiskState({
          exists: result.exists,
          diskModifiedAt: result.modifiedAt,
          loadedModifiedAt: loadedRef.current,
        }))
      } catch {
        // A failed check says nothing: a notice the pane cannot back up is worse than
        // a silent one, and the save path still refuses to overwrite.
        if (!cancelled) setState('unknown')
      }
    }
    void check()
    const timer = setInterval(() => void check(), DISK_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [enabled, path, revision, root])

  return state
}
