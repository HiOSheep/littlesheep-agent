// The static HTML preview surface: the sanitized frame plus what Main said about the
// resources it could not serve (UX-25 items 2 and 4).
//
// Kept out of the preview pane so the pane stays a coordinator: this component owns
// the frame, the asset base the frame needs and the failure notice together, because
// they are one concern — a preview that is missing files has to say which ones.
import { WorkspaceHtmlPreview } from './html-preview'
import { WorkspacePreviewAssetNotice } from './html-preview-asset-notice'
import { useHtmlPreviewAssets } from './use-html-preview-assets'

export function WorkspaceHtmlPreviewSurface({
  root,
  path,
  name,
  content,
  enabled,
}: {
  root: string
  path: string
  name: string
  content: string
  enabled: boolean
}) {
  const assets = useHtmlPreviewAssets({ root, path, source: content, enabled })
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
