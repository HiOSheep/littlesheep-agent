// Hook that owns the HTML "run" state for the file preview pane (UX-26).
//
// Keeping it here rather than in `preview-pane.tsx` matters: that file is at its
// composition ceiling, and the run rules (saved file only, ask about a dirty
// draft, stop releases the service) are one transaction that belongs together.
import { useCallback, useEffect, useState } from 'react'
import { requestWorkspaceBrowserReload } from './browser-reload'
import {
  IDLE_HTML_RUN,
  startHtmlRun,
  stopHtmlRun,
  type HtmlRunState,
} from './html-run'

export interface HtmlRunController {
  state: HtmlRunState
  prompt: boolean
  requestRun: () => void
  saveAndRun: () => void
  cancelPrompt: () => void
  reload: () => void
  stop: () => void
}

export function useHtmlRun({
  workspacePath,
  filePath,
  fileModifiedAt,
  isHtml,
  dirty,
  saveDraft,
  onOpenBrowserTab,
}: {
  workspacePath: string
  filePath: string
  fileModifiedAt: number
  isHtml: boolean
  dirty: boolean
  /** Saves the current draft; false means the run must not happen. */
  saveDraft: () => Promise<boolean>
  onOpenBrowserTab: (url: string) => void
}): HtmlRunController {
  const [state, setState] = useState<HtmlRunState>(IDLE_HTML_RUN)
  const [prompt, setPrompt] = useState(false)

  // A run belongs to the file that was running: a different file, or a refresh of
  // the same one from disk, starts from "not running" again.
  useEffect(() => {
    setState(IDLE_HTML_RUN)
    setPrompt(false)
  }, [filePath, fileModifiedAt])

  const open = useCallback(async () => {
    if (!isHtml || !filePath) return
    setPrompt(false)
    setState({ status: 'starting', url: '', message: '' })
    const next = await startHtmlRun(workspacePath, filePath)
    setState(next)
    if (next.status === 'running') onOpenBrowserTab(next.url)
  }, [filePath, isHtml, onOpenBrowserTab, workspacePath])

  const requestRun = useCallback(() => {
    if (!isHtml) return
    if (dirty) {
      setPrompt(true)
      return
    }
    void open()
  }, [dirty, isHtml, open])

  const saveAndRun = useCallback(() => {
    void (async () => {
      const saved = await saveDraft()
      if (!saved) return
      await open()
    })()
  }, [open, saveDraft])

  const stop = useCallback(() => {
    void (async () => {
      setPrompt(false)
      setState({ status: 'starting', url: '', message: '' })
      setState(await stopHtmlRun(workspacePath))
    })()
  }, [workspacePath])

  // Reloading re-requests the page from the same service, so edits saved to disk show
  // up without restarting anything; the request is addressed by URL so only the
  // browser tab showing this run reloads.
  const reload = useCallback(() => {
    if (state.status !== 'running') return
    requestWorkspaceBrowserReload(state.url)
  }, [state.status, state.url])

  return {
    state,
    prompt,
    requestRun,
    saveAndRun,
    cancelPrompt: useCallback(() => setPrompt(false), []),
    reload,
    stop,
  }
}
