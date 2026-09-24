// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  openWorkspacePathInVSCode,
  type WorkspaceEntry
} from '../api'
import { StringListUpdater } from '../app-shell/types'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { RefreshIcon, SearchIcon, VSCodeIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import { updateWorkspaceDirectoryCache, workspaceDirectoryCache, type WorkspaceDirectoryState } from './directory-cache'
import { compactPath, isPathInsideOrSameClient, workspaceAncestorPaths } from './path-utils'
import { WorkspaceNavigatorFrame } from './navigator-frame'
import { isMissingWorkspacePathError } from './workspace-errors'
import { reportWorkspaceEntriesVisible } from './workspace-timing'
import { WorkspaceTreeNotice, WorkspaceTreeRows, normalizeWorkspaceFilter, workspaceEntryMatchesFilter, MAX_WORKSPACE_DIR_ENTRIES_LABEL } from './workspace-tree-rows'

export { MAX_WORKSPACE_DIR_ENTRIES_LABEL, WorkspaceTreeNotice, WorkspaceTreeRows, normalizeWorkspaceFilter, workspaceDirectoryHasFilterMatch, workspaceEntryMatchesFilter } from './workspace-tree-rows'


export function WorkspaceFileNavigator({
  workspacePath,
  defaultWorkspacePath,
  usingTemporaryRoot,
  navigatorCollapsed,
  navigatorWidth,
  expandedPaths,
  selectedPath,
  onOpenFileTab,
  onReturnToDefaultWorkspace,
  onNavigatorCollapsedChange,
  onNavigatorWidthChange,
  onExpandedPathsChange,
  onTipChange,
}: {
  workspacePath: string
  defaultWorkspacePath: string
  usingTemporaryRoot: boolean
  navigatorCollapsed: boolean
  navigatorWidth: number
  expandedPaths: string[]
  selectedPath: string
  onOpenFileTab: (root: string, path: string) => void
  onReturnToDefaultWorkspace: () => void
  onNavigatorCollapsedChange: (collapsed: boolean) => void
  onNavigatorWidthChange: (width: number) => void
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
    // Keep cached rows visible while a stale entry is refreshed. Toggling a
    // workspace tab should not briefly replace the tree with a loading state.
    const hasCachedRoot = Boolean(cachedDirectories[workspacePath])
    if (!hasCachedRoot) setDirectoryLoading(workspacePath, true)
    workspaceDirectoryCache.load(workspacePath, workspacePath)
      .then((directory) => {
        if (!alive || requestId !== directoryRequestRef.current) return
        commitDirectory(workspacePath, directory)
      })
      .catch((err) => {
        if (!alive || requestId !== directoryRequestRef.current) return
        handleDirectoryError(err, workspacePath)
      })
      .finally(() => {
        if (!alive || requestId !== directoryRequestRef.current) return
        setDirectoryLoading(workspacePath, false)
      })
    return () => {
      alive = false
      if (requestId === directoryRequestRef.current) directoryRequestRef.current += 1
      setLoadingDirs((value) => value.size === 0 ? value : new Set())
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

  useEffect(() => {
    if (navigatorCollapsed) return
    for (const path of expandedPaths) {
      if (!isPathInsideOrSameClient(path, workspacePath) || directories[path]) continue
      void loadDirectory(path)
    }
  }, [directories, expandedPaths, navigatorCollapsed, workspacePath])

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
      handleDirectoryError(err, path)
    } finally {
      if (!mountedRef.current || requestId !== directoryRequestRef.current) return
      setDirectoryLoading(path, false)
    }
  }

  function toggleDirectory(entry: WorkspaceEntry) {
    const shouldLoad = !expanded.has(entry.path) && !directories[entry.path]
    onExpandedPathsChange((paths) => {
      const next = new Set(paths)
      if (next.has(entry.path)) {
        next.delete(entry.path)
      } else {
        next.add(entry.path)
      }
      return [...next]
    })
    if (shouldLoad) void loadDirectory(entry.path)
  }

  function openFile(entry: WorkspaceEntry) {
    onOpenFileTab(workspacePath, entry.path)
  }

  async function openWorkspaceInVSCode() {
    try {
      await openWorkspacePathInVSCode(workspacePath)
    } catch (err) {
      handleWorkspaceActionError(err)
    }
  }

  function handleDirectoryError(error: unknown, path: string) {
    if (isMissingWorkspacePathError(error)) {
      // A file can disappear between the tree read and the child request. Keep
      // the detail in the developer console, but do not expose OS internals in
      // the navigator or leave the vanished branch in a loading state.
      console.debug('[workspace-file-navigator] directory is unavailable', error)
      setTreeError('')
      onExpandedPathsChange((paths) => paths.filter((item) => item !== path))
      return
    }
    setTreeError('文件夹暂时无法读取，请点击刷新重试。')
  }

  function handleWorkspaceActionError(error: unknown) {
    if (isMissingWorkspacePathError(error)) {
      console.debug('[workspace-file-navigator] workspace action target is unavailable', error)
      setTreeError('')
      return
    }
    setTreeError('无法打开当前工作区，请稍后重试。')
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

  // CS-08: the navigator is only "available" once a row is actually painted, so
  // the mark is taken after the frame that shows it - never when a request
  // resolves, and never while the root is still a loading placeholder.
  useEffect(() => {
    if (!rootHasVisibleEntries) return
    const frame = window.requestAnimationFrame(() => reportWorkspaceEntriesVisible())
    return () => window.cancelAnimationFrame(frame)
  }, [rootHasVisibleEntries])

  return (
    <WorkspaceNavigatorFrame
      collapsed={navigatorCollapsed}
      width={navigatorWidth}
      ariaLabel="文件管理"
      onCollapsedChange={onNavigatorCollapsedChange}
      onWidthChange={onNavigatorWidthChange}
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
