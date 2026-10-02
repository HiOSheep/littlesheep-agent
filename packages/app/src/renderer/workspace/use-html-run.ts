// Hook that owns the HTML "run" state for the file preview pane (UX-26).
//
// Previewing an HTML file starts its own local service: the served page is the thing the reader
// asked to see, so there is no 运行 button to press and nothing jumps to a browser on its own. The
// service is released when the preview moves to another file, and the page can still be handed to
// the in-app browser or the system browser from the toolbar — by the reader, not automatically.
import { useEffect, useState } from 'react'
import { requestWorkspaceBrowserReload } from './browser-reload'
import { IDLE_HTML_RUN, startHtmlRun, stopHtmlRun, type HtmlRunState } from './html-run'

export interface HtmlRunController {
  state: HtmlRunState
}

export function useHtmlRun({
  workspacePath,
  filePath,
  fileModifiedAt,
  isHtml,
}: {
  workspacePath: string
  filePath: string
  fileModifiedAt: number
  isHtml: boolean
}): HtmlRunController {
  const [state, setState] = useState<HtmlRunState>(IDLE_HTML_RUN)

  // One service per previewed file. The served page reads from disk on every request, so saving the
  // file needs no new service — and a stable URL is what lets a browser tab opened from the toolbar
  // keep working afterwards.
  useEffect(() => {
    if (!isHtml || !filePath) {
      setState(IDLE_HTML_RUN)
      return undefined
    }
    let disposed = false
    setState({ status: 'starting', url: '', message: '' })
    void startHtmlRun(workspacePath, filePath).then((next) => {
      if (!disposed) setState(next)
    })
    return () => {
      disposed = true
      void stopHtmlRun(workspacePath)
    }
  }, [filePath, isHtml, workspacePath])

  // A saved file is a new page: the pane re-keys its frame off `fileModifiedAt`, and a browser tab
  // already showing this URL is asked to reload, so neither surface keeps the version from before
  // the save. This is the reload the toolbar used to offer as a button.
  useEffect(() => {
    if (fileModifiedAt > 0 && state.status === 'running') requestWorkspaceBrowserReload(state.url)
  }, [fileModifiedAt, state.status, state.url])

  return { state }
}
