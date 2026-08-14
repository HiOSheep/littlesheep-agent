// Renders Git's sparse changed-file tree inside the shared workspace navigator.
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent } from 'react'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FileGlyphIcon, FolderGlyphIcon, RefreshIcon, SearchIcon, TreeChevronIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import { WorkspaceNavigatorFrame } from './navigator-frame'
import { compactPath } from './path-utils'
import {
  workspaceReviewStatusLabel,
  workspaceReviewStatusText,
  type WorkspaceReviewTreeNode,
} from './review-model'
import { ReviewLineCounts } from './review-line-counts'

interface WorkspaceReviewTreeProps {
  workspacePath: string
  repositoryLabel: string
  ahead: number
  behind: number
  nodes: WorkspaceReviewTreeNode[]
  fileCount: number
  totalFileCount: number
  filesTruncated: boolean
  countsComplete: boolean
  additions: number
  deletions: number
  selectedPath: string | null
  expandedFolders: Set<string>
  filterText: string
  refreshing: boolean
  navigatorCollapsed: boolean
  emptyText?: string
  onFilterTextChange: (value: string) => void
  onFilterKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onRefresh: () => void
  onToggleFolder: (path: string) => void
  onSelectFile: (path: string) => void
  onNavigatorCollapsedChange: (collapsed: boolean) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}

export function WorkspaceReviewTree({
  workspacePath,
  repositoryLabel,
  ahead,
  behind,
  nodes,
  fileCount,
  totalFileCount,
  filesTruncated,
  countsComplete,
  additions,
  deletions,
  selectedPath,
  expandedFolders,
  filterText,
  refreshing,
  navigatorCollapsed,
  emptyText,
  onFilterTextChange,
  onFilterKeyDown,
  onRefresh,
  onToggleFolder,
  onSelectFile,
  onNavigatorCollapsedChange,
  onTipChange,
}: WorkspaceReviewTreeProps) {
  return (
    <WorkspaceNavigatorFrame
      collapsed={navigatorCollapsed}
      ariaLabel="Git 更改文件"
      onCollapsedChange={onNavigatorCollapsedChange}
      onTipChange={onTipChange}
    >
      <div className="workspace-files-toolbar workspace-page-leading-row">
        <div className="workspace-files-root">
          <span title={repositoryLabel}>
            {repositoryLabel}
            <b className="workspace-root-badge">Git 审阅</b>
          </span>
          <small title={workspacePath}>
            {compactPath(workspacePath)}
            {ahead > 0 ? ` · 领先 ${ahead}` : ''}
            {behind > 0 ? ` · 落后 ${behind}` : ''}
          </small>
        </div>
        <div className="workspace-files-actions">
          <button
            {...transientTriggerProps()}
            className={`workspace-files-icon-btn ${refreshing ? 'refreshing' : ''}`}
            type="button"
            aria-label="刷新 Git 更改"
            disabled={refreshing}
            onClick={onRefresh}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新 Git 更改', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新 Git 更改', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新 Git 更改', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <RefreshIcon />
          </button>
        </div>
      </div>
      <label className="workspace-file-filter">
        <span aria-hidden="true"><SearchIcon /></span>
        <input
          type="search"
          value={filterText}
          placeholder="筛选更改..."
          aria-label="筛选更改文件"
          onChange={(event) => onFilterTextChange(event.target.value)}
          onKeyDown={onFilterKeyDown}
        />
      </label>
      <div className="workspace-review-tree-summary">
        <span>{filesTruncated ? `${fileCount}/${totalFileCount}` : fileCount} 个文件</span>
        <ReviewLineCounts additions={additions} deletions={deletions} available={countsComplete} />
      </div>
      <div className="workspace-tree workspace-review-tree-scroll" role="tree" aria-label="当前 Git 更改文件树">
        {nodes.length === 0 && emptyText ? (
          <div className="workspace-tree-notice workspace-review-tree-empty" role="status">{emptyText}</div>
        ) : null}
        {nodes.map((node) => (
          <WorkspaceReviewTreeRow
            key={`${node.kind}:${node.path}`}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onSelectFile={onSelectFile}
            onTipChange={onTipChange}
          />
        ))}
      </div>
    </WorkspaceNavigatorFrame>
  )
}

function WorkspaceReviewTreeRow({
  node,
  depth,
  selectedPath,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  onTipChange,
}: Pick<WorkspaceReviewTreeProps,
  'selectedPath' | 'expandedFolders' | 'onToggleFolder' | 'onSelectFile' | 'onTipChange'
> & {
  node: WorkspaceReviewTreeNode
  depth: number
}) {
  const rowTip = node.path
  const tipHandlers = {
    onMouseEnter: (event: MouseEvent<HTMLElement>) => onTipChange(buildFloatingHelpTip(rowTip, event.clientX, event.clientY)),
    onMouseMove: (event: MouseEvent<HTMLElement>) => onTipChange(buildFloatingHelpTip(rowTip, event.clientX, event.clientY)),
    onMouseLeave: () => onTipChange(null),
    onFocus: (event: FocusEvent<HTMLElement>) => onTipChange(buildFloatingHelpTipFromElement(rowTip, event.currentTarget)),
    onBlur: () => onTipChange(null),
  }

  if (node.kind === 'folder') {
    const expanded = expandedFolders.has(node.path)
    return (
      <div className="workspace-review-tree-branch" role="none">
        <button
          className="workspace-tree-row workspace-review-tree-row directory"
          type="button"
          role="treeitem"
          aria-expanded={expanded}
          style={{ '--workspace-tree-depth': depth } as CSSProperties}
          onClick={() => onToggleFolder(node.path)}
          {...tipHandlers}
        >
          <span className={`workspace-tree-chevron ${expanded ? 'open' : ''}`} aria-hidden="true">
            <TreeChevronIcon />
          </span>
          <span className="workspace-tree-glyph"><FolderGlyphIcon /></span>
          <span className="workspace-tree-name">{node.name}</span>
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
            onTipChange={onTipChange}
          />
        ))}
      </div>
    )
  }

  const statusText = workspaceReviewStatusText(node.file.status)
  const selected = selectedPath === node.path
  return (
    <button
      className={`workspace-tree-row workspace-review-tree-row file ${selected ? 'selected' : ''}`}
      type="button"
      role="treeitem"
      aria-selected={selected}
      style={{ '--workspace-tree-depth': depth } as CSSProperties}
      onClick={() => onSelectFile(node.path)}
      {...tipHandlers}
    >
      <span className={`workspace-review-file-status ${node.file.status}`} aria-label={statusText} title={statusText}>
        {workspaceReviewStatusLabel(node.file.status)}
      </span>
      <span className="workspace-tree-glyph"><FileGlyphIcon /></span>
      <span className="workspace-tree-name">{node.name}</span>
      <ReviewLineCounts
        additions={node.additions}
        deletions={node.deletions}
        available={node.countAvailable}
        compact
      />
    </button>
  )
}
