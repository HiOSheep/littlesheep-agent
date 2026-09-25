// Relative styles, images and fonts in the *static* preview (UX-25 item 2).
//
// The frame is `sandbox=""` with an opaque origin, so Chromium refuses `file:`
// subresources and a stylesheet next to the HTML file simply never loads. Main's
// bounded loopback service is the sanctioned way in: every request is resolved
// against the selected workspace root, traversal and symlinks are refused, and the
// frame itself still cannot fetch anything (`connect-src 'none'`).
//
// The service is started only when the document actually references something local,
// so previewing plain text or a self-contained page does not open a listener. It is
// never stopped from here: the run entry shares the same per-root server, and Main's
// idle timeout reaps it when nobody is using it.
import { useEffect, useMemo, useState } from 'react'
import {
  listWorkspacePreviewServers,
  startWorkspacePreviewServer,
  type WorkspacePreviewAssetFailure,
} from '../api/workspace-preview-server'
import { previewDocumentPath } from './html-preview'
import { htmlPreviewNeedsAssets } from './html-preview-assets'

export interface HtmlPreviewAssetsState {
  /** Service root including the token, or undefined while there is nothing to serve. */
  base?: string
  /** Document path relative to the workspace root, derived from path and oot. */
  relativePath: string
  failures: WorkspacePreviewAssetFailure[]
  /** Re-key the frame to try the failed resources again. */
  retry: () => void
  attempt: number
}

const POLL_INTERVAL_MS = 3000

export function useHtmlPreviewAssets({
  root,
  path,
  source,
  enabled,
}: {
  root: string
  path: string
  source: string
  enabled: boolean
}): HtmlPreviewAssetsState {
  const needsAssets = useMemo(() => enabled && htmlPreviewNeedsAssets(source), [enabled, source])
  // The absolute path plus the root is the reliable source of the directories; a
  // preview's own relative path may be just the file name (measured with multi-file).
  const documentPath = useMemo(() => previewDocumentPath(path, root), [path, root])
  const [base, setBase] = useState<string | undefined>(undefined)
  const [failures, setFailures] = useState<WorkspacePreviewAssetFailure[]>([])
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!needsAssets) {
      setBase(undefined)
      setFailures([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const info = await startWorkspacePreviewServer(root, path)
        if (cancelled) return
        // `info.url` ends with the entry document: the service root is what is left.
        setBase(serviceRoot(info.url, info.entry))
      } catch {
        if (!cancelled) setBase(undefined)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [attempt, needsAssets, path, root])

  useEffect(() => {
    if (!base) return
    let cancelled = false
    const poll = async () => {
      try {
        const servers = await listWorkspacePreviewServers()
        if (cancelled) return
        const mine = servers.servers?.find((server) => server.root === root)
        setFailures(mine?.assetFailures ?? [])
      } catch {
        // A preview that cannot read the service list simply shows no reasons.
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [attempt, base, root])

  return {
    base,
    relativePath: documentPath,
    failures,
    retry: () => {
      setFailures([])
      setAttempt((value) => value + 1)
    },
    attempt,
  }
}

/**
 * The service root for a document URL: everything up to and including the token.
 *
 * `entry` is the document's path inside the root, so the URL minus that suffix is the
 * base every resolved reference is appended to.
 */
export function serviceRoot(url: string, entry: string): string {
  const suffix = entry ? `/${entry.split('/').map((segment) => encodeURIComponent(segment)).join('/')}` : ''
  if (suffix && url.endsWith(suffix)) return url.slice(0, url.length - suffix.length) + '/'
  const index = url.lastIndexOf('/')
  return index < 0 ? `${url}/` : `${url.slice(0, index + 1)}`
}
