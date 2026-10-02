// The HTML preview surface: the served page while its local service is up, and otherwise the
// sanitized static frame plus what Main said about the resources it could not serve (UX-25 items 2
// and 4).
//
// Kept out of the preview pane so the pane stays a coordinator: this component owns the frame, the
// asset base the frame needs and the failure notice together, because they are one concern — a
// preview that is missing files has to say which ones — and it is also the one place that decides
// between "the page is running" and "show what can be shown without running it".
import { WorkspaceHtmlPreview } from './html-preview'
import { WorkspacePreviewAssetNotice } from './html-preview-asset-notice'
import { useHtmlPreviewAssets } from './use-html-preview-assets'

export function WorkspaceHtmlPreviewSurface({
  root,
  path,
  name,
  content,
  enabled,
  liveUrl = '',
  liveKey = 0,
}: {
  root: string
  path: string
  name: string
  content: string
  enabled: boolean
  /** The running page's loopback URL, or empty while it is still starting / could not start. */
  liveUrl?: string
  /** Changes when the file is saved, so the served page reloads in place under a stable URL. */
  liveKey?: number
}) {
  const assets = useHtmlPreviewAssets({ root, path, source: content, enabled: enabled && !liveUrl })
  if (liveUrl) {
    return (
      <iframe
        className="workspace-preview-html-live"
        key={liveKey}
        title={name}
        src={liveUrl}
        /* The page is served from its own tokenised loopback origin, so `allow-same-origin` gives it
           that origin's storage (a game keeps its progress there) and not this window's: the app
           stays cross-origin to it either way. */
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        referrerPolicy="no-referrer"
      />
    )
  }
  return (
    <>
      <WorkspaceHtmlPreview
        path={path}
        name={name}
        content={content}
        assetBase={assets.base}
        documentPath={assets.relativePath}
      />
      <WorkspacePreviewAssetNotice failures={assets.failures} onRetry={assets.retry} />
    </>
  )
}
