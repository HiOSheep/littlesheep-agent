// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  openWorkspacePathInVSCode,
  type WorkspaceEntry
} from '../api'
import { StringListUpdater } from '../app-shell/types'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FileGlyphIcon, FolderGlyphIcon, RefreshIcon, SearchIcon, TreeChevronIcon, VSCodeIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import {
  type WorkspaceDirectoryState,
  updateWorkspaceDirectoryCache,
  workspaceDirectoryCache,
} from './directory-cache'
import { compactPath, formatFileSize, workspaceAncestorPaths } from './path-utils'
import { WorkspaceNavigatorFrame } from './navigator-frame'


export function WorkspaceFileNavigator({
  workspacePath,
  defaultWorkspacePath,
  usingTemporaryRoot,
  navigatorCollapsed,
  expandedPaths,
  selectedPath,
  onOpenFileTab,
  onReturnToDefaultWorkspace,
  onNavigatorCollapsedChange,
  onExpandedPathsChange,
  onTipChange,
}: {
  workspacePath: string
  defaultWorkspacePath: string
  usingTemporaryRoot: boolean
  navigatorCollapsed: boolean
  expandedPaths: string[]
  selectedPath: string
  onOpenFileTab: (root: string, path: string) => void
  onReturnToDefaultWorkspace: () => void
  onNavigatorCollapsedChange: (collapsed: boolean) => void
  onExpandedPathsChange: (update: StringListUpdater) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [directories, setDirectories] = useState<Record<string, WorkspaceDirectoryState>>(
    () => workspaceDirectoryCache.read(workspacePath),
  )
  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths])
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [treeError, setTreeError] = useState('')
  const [filterText, setFilterText] = useState('')
  const directoryRequestRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      directoryRequestRef.current += 1
    }
  }, [])

  useLayoutEffect(() => {
    if (navigatorCollapsed) return
    let alive = true
    const requestId = ++directoryRequestRef.current
    const cachedDirectories = workspaceDirectoryCache.read(workspacePath)
    setDirectories(cachedDirectories)
    onExpandedPathsChange((paths) => paths.includes(workspacePath) ? paths : [...paths, workspacePath])
    setTreeError('')
    setDirectoryLoading(workspacePath, true)
    workspaceDirectoryCache.load(workspacePath, workspacePath)
      .then((directory) => {
        if (!alive || requestId !== directoryRequestRef.current) return
        commitDirectory(workspacePath, directory)
      })
      .catch((err) => {
        if (!alive || requestId !== directoryRequestRef.current) return
        setTreeError((err as Error).message)
      })
      .finally(() => {
        if (!alive || requestId !== directoryRequestRef.current) return
        setDirectoryLoading(workspacePath, false)
      })
    return () => {
      alive = false
    }
  }, [navigatorCollapsed, workspacePath])

  useEffect(() => {
    if (navigatorCollapsed) return
    const ancestors = workspaceAncestorPaths(workspacePath, selectedPath)
    if (ancestors.length === 0) return
    onExpandedPathsChange((paths) => [...paths, ...ancestors])
    for (const path of ancestors) {
      if (!directories[path]) void loadDirectory(path)
    }
  }, [navigatorCollapsed, selectedPath, workspacePath])

  function setDirectoryLoading(path: string, loading: boolean) {
    setLoadingDirs((value) => {
      const next = new Set(value)
      if (loading) next.add(path)
      else next.delete(path)
      return next
    })
  }

  function commitDirectory(
    requestedPath: string,
    directory: Awaited<ReturnType<typeof workspaceDirectoryCache.load>>,
  ) {
    if (!mountedRef.current) return
    const state: WorkspaceDirectoryState = {
      entries: directory.entries,
      truncated: directory.truncated,
      hiddenCount: directory.hiddenCount,
    }
    setDirectories((value) => updateWorkspaceDirectoryCache(
      value,
      requestedPath,
      directory.path,
      state,
      workspacePath,
    ))
  }

  async function loadDirectory(path: string, force = false) {
    const requestId = directoryRequestRef.current
    setTreeError('')
    setDirectoryLoading(path, true)
    try {
      const directory = await workspaceDirectoryCache.load(workspacePath, path, { force })
      if (!mountedRef.current || requestId !== directoryRequestRef.current) return
      commitDirectory(path, directory)
    } catch (err) {
      if (!mountedRef.current || requestId !== directoryRequestRef.current) return
      setTreeError((err as Error).message)
    } finally {
      if (!mountedRef.current || requestId !== directoryRequestRef.current) return
      setDirectoryLoading(path, false)
    }
  }

  function toggleDirectory(entry: WorkspaceEntry) {
    onExpandedPathsChange((paths) => {
      const next = new Set(paths)
      if (next.has(entry.path)) {
        next.delete(entry.path)
      } else {
        next.add(entry.path)
        if (!directories[entry.path]) void loadDirectory(entry.path)
      }
      return [...next]
    })
  }

  function openFile(entry: WorkspaceEntry) {
    onOpenFileTab(workspacePath, entry.path)
  }

  async function openWorkspaceInVSCode() {
    try {
      await openWorkspacePathInVSCode(workspacePath)
    } catch (err) {
      setTreeError((err as Error).message)
    }
  }

  function refreshTree() {
    void loadDirectory(workspacePath, true)
    const ancestors = workspaceAncestorPaths(workspacePath, selectedPath)
    for (const path of ancestors) void loadDirectory(path, true)
  }

  const rootInfo = directories[workspacePath]
  const loadingRoot = loadingDirs.has(workspacePath)
  const normalizedFilter = normalizeWorkspaceFilter(filterText)
  const rootHasVisibleEntries = rootInfo
    ? rootInfo.entries.some((entry) => workspaceEntryMatchesFilter(entry, directories, normalizedFilter))
    : false

  return (
    <WorkspaceNavigatorFrame
      collapsed={navigatorCollapsed}
      ariaLabel="文件管理"
      onCollapsedChange={onNavigatorCollapsedChange}
      onTipChange={onTipChange}
    >
        <div className="workspace-files-toolbar workspace-page-leading-row">
          <div className="workspace-files-root">
            <span>
              {compactPath(workspacePath)}
              <b className={`workspace-root-badge ${usingTemporaryRoot ? 'temporary' : ''}`}>
                {usingTemporaryRoot ? '临时预览' : '当前工作区'}
              </b>
            </span>
            <small>{usingTemporaryRoot ? `来源不改变当前工作区：${defaultWorkspacePath}` : workspacePath}</small>
          </div>
          <div className="workspace-files-actions">
            {usingTemporaryRoot && (
              <button
                {...transientTriggerProps()}
                className="workspace-files-text-btn"
                type="button"
                onClick={onReturnToDefaultWorkspace}
                onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('回到当前工作区', event.clientX, event.clientY))}
                onMouseMove={(event) => onTipChange(buildFloatingHelpTip('回到当前工作区', event.clientX, event.clientY))}
                onMouseLeave={() => onTipChange(null)}
                onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('回到当前工作区', event.currentTarget))}
                onBlur={() => onTipChange(null)}
              >
                回到工作区
              </button>
            )}
            <button
              {...transientTriggerProps()}
              className="workspace-files-icon-btn"
              type="button"
              aria-label="用外部 VS Code 打开工作区"
              onClick={() => void openWorkspaceInVSCode()}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('用外部 VS Code 打开工作区', event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip('用外部 VS Code 打开工作区', event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('用外部 VS Code 打开工作区', event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <VSCodeIcon />
            </button>
            <button
              {...transientTriggerProps()}
              className="workspace-files-icon-btn"
              type="button"
              aria-label="刷新文件树"
              onClick={refreshTree}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新文件树', event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新文件树', event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新文件树', event.currentTarget))}
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
            placeholder="筛选文件..."
            aria-label="筛选文件"
            onChange={(event) => setFilterText(event.target.value)}
          />
        </label>
        <div className="workspace-tree" role="tree" aria-label="当前工作区文件树">
          {loadingRoot && !rootInfo && <WorkspaceTreeNotice text="正在读取文件树..." />}
          {treeError && <WorkspaceTreeNotice text={treeError} tone="error" />}
          {rootInfo && rootInfo.entries.length === 0 && <WorkspaceTreeNotice text="这个文件夹是空的。" />}
          {rootInfo && normalizedFilter && !rootHasVisibleEntries && <WorkspaceTreeNotice text="没有匹配的文件。" />}
          {rootInfo && (
            <WorkspaceTreeRows
              dirPath={workspacePath}
              depth={0}
              directories={directories}
              expanded={expanded}
              loadingDirs={loadingDirs}
              selectedPath={selectedPath}
              filterText={normalizedFilter}
              onToggleDirectory={toggleDirectory}
              onOpenFile={openFile}
              onTipChange={onTipChange}
            />
          )}
          {rootInfo && (rootInfo.hiddenCount > 0 || rootInfo.truncated) && (
            <WorkspaceTreeNotice
              text={[
                rootInfo.hiddenCount > 0 ? `已隐藏 ${rootInfo.hiddenCount} 个重目录或链接` : '',
                rootInfo.truncated ? `已截断到前 ${MAX_WORKSPACE_DIR_ENTRIES_LABEL} 项` : '',
              ].filter(Boolean).join('，')}
            />
          )}
        </div>
    </WorkspaceNavigatorFrame>
  )
}


export const MAX_WORKSPACE_DIR_ENTRIES_LABEL = 320


export function WorkspaceTreeRows({
  dirPath,
  depth,
  directories,
  expanded,
  loadingDirs,
  selectedPath,
  filterText,
  onToggleDirectory,
  onOpenFile,
  onTipChange,
}: {
  dirPath: string
  depth: number
  directories: Record<string, WorkspaceDirectoryState>
  expanded: Set<string>
  loadingDirs: Set<string>
  selectedPath: string
  filterText: string
  onToggleDirectory: (entry: WorkspaceEntry) => void
  onOpenFile: (entry: WorkspaceEntry) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const directory = directories[dirPath]
  if (!directory) return null

  return (
    <>
      {directory.entries.map((entry) => {
        if (!workspaceEntryMatchesFilter(entry, directories, filterText)) return null
        const directoryEntry = entry.kind === 'directory'
        const open = directoryEntry && (
          expanded.has(entry.path) ||
          (Boolean(filterText) && workspaceDirectoryHasFilterMatch(entry.path, directories, filterText))
        )
        const selected = entry.path === selectedPath
        const loading = loadingDirs.has(entry.path)
        const tip = `${entry.name}\n${entry.path}`
        return (
          <div key={entry.path}>
            <button
              className={`workspace-tree-row ${directoryEntry ? 'directory' : 'file'} ${selected ? 'selected' : ''}`}
              type="button"
              role="treeitem"
              aria-expanded={directoryEntry ? open : undefined}
              aria-selected={!directoryEntry ? selected : undefined}
              style={{ '--workspace-tree-depth': depth } as CSSProperties}
              onClick={() => directoryEntry ? onToggleDirectory(entry) : onOpenFile(entry)}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <span className={`workspace-tree-chevron ${open ? 'open' : ''}`}>
                {directoryEntry ? <TreeChevronIcon /> : null}
              </span>
              <span className="workspace-tree-glyph">
                {directoryEntry ? <FolderGlyphIcon /> : <FileGlyphIcon />}
              </span>
              <span className="workspace-tree-name">{entry.name}</span>
              {!directoryEntry && entry.size !== undefined && (
                <span className="workspace-tree-size">{formatFileSize(entry.size)}</span>
              )}
              {loading && <span className="workspace-tree-loading" />}
            </button>
            {directoryEntry && open && (
              directories[entry.path]
                ? (
                  <WorkspaceTreeRows
                    dirPath={entry.path}
                    depth={depth + 1}
                    directories={directories}
                    expanded={expanded}
                    loadingDirs={loadingDirs}
                    selectedPath={selectedPath}
                    filterText={filterText}
                    onToggleDirectory={onToggleDirectory}
                    onOpenFile={onOpenFile}
                    onTipChange={onTipChange}
                  />
                )
                : <WorkspaceTreeNotice text="正在读取..." indent={depth + 1} />
            )}
          </div>
        )
      })}
      {directory.entries.length > 0 && (directory.hiddenCount > 0 || directory.truncated) && depth > 0 && (
        <WorkspaceTreeNotice
          indent={depth + 1}
          text={[
            directory.hiddenCount > 0 ? `隐藏 ${directory.hiddenCount} 项` : '',
            directory.truncated ? '列表已截断' : '',
          ].filter(Boolean).join('，')}
        />
      )}
    </>
  )
}


export function normalizeWorkspaceFilter(value: string): string {
  return value.trim().toLowerCase()
}


export function workspaceEntryMatchesFilter(
  entry: WorkspaceEntry,
  directories: Record<string, WorkspaceDirectoryState>,
  filterText: string,
): boolean {
  if (!filterText) return true
  const entryText = `${entry.name} ${entry.relativePath} ${entry.path}`.toLowerCase()
  if (entryText.includes(filterText)) return true
  return entry.kind === 'directory' && workspaceDirectoryHasFilterMatch(entry.path, directories, filterText)
}


export function workspaceDirectoryHasFilterMatch(
  path: string,
  directories: Record<string, WorkspaceDirectoryState>,
  filterText: string,
): boolean {
  const directory = directories[path]
  if (!directory) return false
  return directory.entries.some((entry) => workspaceEntryMatchesFilter(entry, directories, filterText))
}


export function WorkspaceTreeNotice({
  text,
  tone = 'muted',
  indent = 0,
}: {
  text: string
  tone?: 'muted' | 'error'
  indent?: number
}) {
  return (
    <div
      className={`workspace-tree-notice ${tone}`}
      style={{ '--workspace-tree-depth': indent } as CSSProperties}
    >
      {text}
    </div>
  )
}
