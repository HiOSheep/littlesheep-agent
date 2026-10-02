// The trail above a file: the labels `workspaceBreadcrumbs` produces, each ancestor a target the
// reader can click to reveal that folder in the file navigator, and the file itself the brightest,
// unclickable end of the row. It lives here rather than in the preview pane because the pane grows
// with every preview feature, and the trail is a reading device of its own.
import { workspaceBreadcrumbFolders, workspaceBreadcrumbs } from './path-utils'


export function WorkspacePreviewBreadcrumbs({
  root,
  path,
  fallbackLabel,
  onRevealFolder,
}: {
  root: string
  path: string
  /** Shown when no file is open. */
  fallbackLabel: string
  /** Reveals one folder of this path in the file navigator. */
  onRevealFolder?: (path: string) => void
}) {
  const labels = path ? workspaceBreadcrumbs(root, path) : []
  const parts = labels.length > 0 ? labels : [fallbackLabel]
  // One entry per label, in label order: the folder that label names, or null for the file itself.
  const folders = path ? workspaceBreadcrumbFolders(root, path) : []

  return (
    <div className="workspace-preview-breadcrumbs" aria-label="文件路径">
      {parts.map((part, index) => {
        const folder = folders[index] ?? null
        return (
          <span key={`${part}-${index}`}>
            {index > 0 && <i aria-hidden="true">/</i>}
            {folder && onRevealFolder ? (
              <button
                className="workspace-preview-crumb"
                type="button"
                title={folder}
                aria-label={`在文件夹栏中定位 ${part}`}
                onClick={() => onRevealFolder(folder)}
              >
                {part}
              </button>
            ) : <em>{part}</em>}
          </span>
        )
      })}
    </div>
  )
}
