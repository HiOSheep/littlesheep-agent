// Renders the sparse changed-file tree and its recursive folder interaction.
import type { CSSProperties } from 'react'
import { FileGlyphIcon, FolderGlyphIcon, TreeChevronIcon } from '../ui/icons'
import {
  workspaceReviewStatusLabel,
  workspaceReviewStatusText,
  type WorkspaceReviewTreeNode,
} from './review-model'
import { ReviewLineCounts } from './review-line-counts'

interface WorkspaceReviewTreeProps {
  nodes: WorkspaceReviewTreeNode[]
  fileCount: number
  totalFileCount: number
  filesTruncated: boolean
  countsComplete: boolean
  additions: number
  deletions: number
  selectedPath: string | null
  expandedFolders: Set<string>
  onToggleFolder: (path: string) => void
  onSelectFile: (path: string) => void
}

export function WorkspaceReviewTree({
  nodes,
  fileCount,
  totalFileCount,
  filesTruncated,
  countsComplete,
  additions,
  deletions,
  selectedPath,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
}: WorkspaceReviewTreeProps) {
  return (
    <aside className="workspace-review-tree" aria-label="Git 更改文件">
      <div className="workspace-review-tree-summary">
        <span>{filesTruncated ? `${fileCount}/${totalFileCount}` : fileCount} 个文件</span>
        <ReviewLineCounts
          additions={additions}
          deletions={deletions}
          available={countsComplete}
        />
      </div>
      <div className="workspace-review-tree-scroll">
        {nodes.map((node) => (
          <WorkspaceReviewTreeRow
            key={`${node.kind}:${node.path}`}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    </aside>
  )
}

function WorkspaceReviewTreeRow({
  node,
  depth,
  selectedPath,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
}: Pick<WorkspaceReviewTreeProps, 'selectedPath' | 'expandedFolders' | 'onToggleFolder' | 'onSelectFile'> & {
  node: WorkspaceReviewTreeNode
  depth: number
}) {
  if (node.kind === 'folder') {
    const expanded = expandedFolders.has(node.path)
    return (
      <div className="workspace-review-tree-branch">
        <button
          className="workspace-review-tree-row folder"
          type="button"
          aria-expanded={expanded}
          style={{ '--review-tree-depth': depth } as CSSProperties}
          onClick={() => onToggleFolder(node.path)}
        >
          <span className={`workspace-review-tree-chevron ${expanded ? 'expanded' : ''}`} aria-hidden="true">
            <TreeChevronIcon />
          </span>
          <FolderGlyphIcon />
          <span className="workspace-review-tree-name">{node.name}</span>
          <ReviewLineCounts
            additions={node.additions}
            deletions={node.deletions}
            available={node.countAvailable}
            compact
          />
        </button>
        {expanded && node.children.map((child) => (
          <WorkspaceReviewTreeRow
            key={`${child.kind}:${child.path}`}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    )
  }

  const statusText = workspaceReviewStatusText(node.file.status)
  return (
    <button
      className={`workspace-review-tree-row file ${selectedPath === node.path ? 'selected' : ''}`}
      type="button"
      aria-current={selectedPath === node.path ? 'true' : undefined}
      style={{ '--review-tree-depth': depth } as CSSProperties}
      onClick={() => onSelectFile(node.path)}
    >
      <span className={`workspace-review-file-status ${node.file.status}`} aria-label={statusText} title={statusText}>
        {workspaceReviewStatusLabel(node.file.status)}
      </span>
      <FileGlyphIcon />
      <span className="workspace-review-tree-name">{node.name}</span>
      <ReviewLineCounts
        additions={node.additions}
        deletions={node.deletions}
        available={node.countAvailable}
        compact
      />
    </button>
  )
}
