// Pure recursive file-tree rows and filter helpers for the workspace navigator.
import type { CSSProperties } from 'react'
import type { WorkspaceEntry } from '../api'
import { openWorkspacePathInVSCode, revealWorkspacePath } from '../api/workspace-files'
import { openContextMenu } from '../ui/context-menu'
import { FileGlyphIcon, FolderGlyphIcon, TreeChevronIcon } from '../ui/icons'
import { type WorkspaceDirectoryState } from './directory-cache'

export const MAX_WORKSPACE_DIR_ENTRIES_LABEL = 320

export function WorkspaceTreeRows({
  dirPath, depth, directories, expanded, loadingDirs, selectedPath, filterText, onToggleDirectory, onOpenFile, workspaceRoot = dirPath,
}: {
  dirPath: string
  workspaceRoot?: string
  depth: number
  directories: Record<string, WorkspaceDirectoryState>
  expanded: Set<string>
  loadingDirs: Set<string>
  selectedPath: string
  filterText: string
  onToggleDirectory: (entry: WorkspaceEntry) => void
  onOpenFile: (entry: WorkspaceEntry) => void
}) {
  const directory = directories[dirPath]
  if (!directory) return null
  return <>
    {directory.entries.map((entry) => {
      if (!workspaceEntryMatchesFilter(entry, directories, filterText)) return null
      const directoryEntry = entry.kind === 'directory'
      const open = directoryEntry && (expanded.has(entry.path) || (Boolean(filterText) && workspaceDirectoryHasFilterMatch(entry.path, directories, filterText)))
      const selected = entry.path === selectedPath
      const loading = loadingDirs.has(entry.path)
      return <div key={entry.path} className={`workspace-tree-entry ${directoryEntry && open ? 'expanded' : ''}`} style={{ '--workspace-tree-depth': depth } as CSSProperties}>
        <button className={`workspace-tree-row ${directoryEntry ? 'directory' : 'file'} ${selected ? 'selected' : ''}`} type="button" role="treeitem" aria-expanded={directoryEntry ? open : undefined} aria-selected={!directoryEntry ? selected : undefined} style={{ '--workspace-tree-depth': depth } as CSSProperties} onClick={() => directoryEntry ? onToggleDirectory(entry) : onOpenFile(entry)}
          onContextMenu={(event) => {
            event.preventDefault()
            event.currentTarget.focus({ preventScroll: true })
            openContextMenu(event.clientX, event.clientY, [
              { id: 'open', label: directoryEntry ? (open ? '收起文件夹' : '展开文件夹') : '在应用内预览', run: () => directoryEntry ? onToggleDirectory(entry) : onOpenFile(entry) },
              { id: 'vscode', label: '在 Visual Studio Code 中打开', run: () => openWorkspacePathInVSCode(workspaceRoot, entry.path) },
              { id: 'reveal', label: '显示文件位置', run: () => revealWorkspacePath(workspaceRoot, entry.path) },
              { id: 'copy-path', label: '复制完整路径', dividerBefore: true, run: () => navigator.clipboard.writeText(entry.path) },
              { id: 'copy-relative', label: '复制相对路径', run: () => navigator.clipboard.writeText(entry.relativePath) },
            ])
          }}>
          <span className={`workspace-tree-chevron ${open ? 'open' : ''}`}>{directoryEntry ? <TreeChevronIcon /> : null}</span>
          <span className="workspace-tree-glyph">{directoryEntry ? <FolderGlyphIcon /> : <FileGlyphIcon name={entry.name} />}</span>
          <span className="workspace-tree-name">{entry.name}</span>
          {loading && <span className="workspace-tree-loading" />}
        </button>
        {directoryEntry && open && (directories[entry.path]
          ? <WorkspaceTreeRows workspaceRoot={workspaceRoot} dirPath={entry.path} depth={depth + 1} directories={directories} expanded={expanded} loadingDirs={loadingDirs} selectedPath={selectedPath} filterText={filterText} onToggleDirectory={onToggleDirectory} onOpenFile={onOpenFile} />
          : <WorkspaceTreeNotice text="正在读取..." indent={depth + 1} />)}
      </div>
    })}
    {directory.entries.length > 0 && (directory.hiddenCount > 0 || directory.truncated) && depth > 0 && <WorkspaceTreeNotice indent={depth + 1} text={[directory.hiddenCount > 0 ? `隐藏 ${directory.hiddenCount} 项` : '', directory.truncated ? '列表已截断' : ''].filter(Boolean).join('，')} />}
  </>
}

export function normalizeWorkspaceFilter(value: string): string { return value.trim().toLowerCase() }

export function workspaceEntryMatchesFilter(entry: WorkspaceEntry, directories: Record<string, WorkspaceDirectoryState>, filterText: string): boolean {
  if (!filterText) return true
  const entryText = `${entry.name} ${entry.relativePath} ${entry.path}`.toLowerCase()
  return entryText.includes(filterText) || (entry.kind === 'directory' && workspaceDirectoryHasFilterMatch(entry.path, directories, filterText))
}

export function workspaceDirectoryHasFilterMatch(path: string, directories: Record<string, WorkspaceDirectoryState>, filterText: string): boolean {
  const directory = directories[path]
  return Boolean(directory?.entries.some((entry) => workspaceEntryMatchesFilter(entry, directories, filterText)))
}

export function WorkspaceTreeNotice({ text, tone = 'muted', indent = 0 }: { text: string; tone?: 'muted' | 'error'; indent?: number }) {
  return <div className={`workspace-tree-notice ${tone}`} style={{ '--workspace-tree-depth': indent } as CSSProperties}>{text}</div>
}
