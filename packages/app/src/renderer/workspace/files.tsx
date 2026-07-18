// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  listWorkspaceDirectory,
  openWorkspacePathInVSCode,
  previewWorkspaceFile,
  saveWorkspaceFile,
  type WorkspaceDirectory,
  type WorkspaceEntry,
  type WorkspacePreview
} from '../api'
import { StringListUpdater } from '../app-shell/types'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FolderGlyphIcon, PanelCollapseIcon, RefreshIcon, SearchIcon, VSCodeIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import {
  type WorkspaceOpenRequest
} from '../workspace-persistence'
import { WorkspaceDirectoryState, updateWorkspaceDirectoryCache } from './directory-cache'
import { MAX_WORKSPACE_DIR_ENTRIES_LABEL, WorkspaceTreeNotice, WorkspaceTreeRows, normalizeWorkspaceFilter, workspaceEntryMatchesFilter } from './file-navigator'
import { compactPath, directoryPath, isSamePath, lastPathSegment, workspaceBreadcrumbs } from './path-utils'
import { WorkspacePreviewPane } from './preview-pane'


export function WorkspaceFiles({
  workspacePath,
  defaultWorkspacePath,
  usingTemporaryRoot,
  navigatorCollapsed,
  expandedPaths,
  openRequest,
  sessionId,
  onRememberOpenPath,
  onReturnToDefaultWorkspace,
  onRequestFileSaveApproval,
  onWorkspaceArtifactsChanged,
  onNavigatorCollapsedChange,
  onExpandedPathsChange,
  onOpenFileTab,
  onTipChange,
}: {
  workspacePath: string
  defaultWorkspacePath: string
  usingTemporaryRoot: boolean
  navigatorCollapsed: boolean
  expandedPaths: string[]
  openRequest: WorkspaceOpenRequest | null
  sessionId?: string
  onRememberOpenPath: (root: string, path: string) => void
  onReturnToDefaultWorkspace: () => void
  onRequestFileSaveApproval: (detail: unknown) => Promise<boolean>
  onWorkspaceArtifactsChanged: () => void
  onNavigatorCollapsedChange: (collapsed: boolean) => void
  onExpandedPathsChange: (update: StringListUpdater) => void
  onOpenFileTab: (root: string, path: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [directories, setDirectories] = useState<Record<string, WorkspaceDirectoryState>>({})
  const expanded = useMemo(() => new Set(expandedPaths), [expandedPaths])
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set())
  const [treeError, setTreeError] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [preview, setPreview] = useState<WorkspacePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [filterText, setFilterText] = useState('')
  const directoryRequestRef = useRef(0)
  const previewRequestRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      directoryRequestRef.current += 1
      previewRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    let alive = true
    const requestId = ++directoryRequestRef.current
    setDirectories({})
    onExpandedPathsChange((paths) => paths.includes(workspacePath) ? paths : [...paths, workspacePath])
    setTreeError('')
    setSelectedPath('')
    setPreview(null)
    setPreviewError('')
    setDirectoryLoading(workspacePath, true)
    listWorkspaceDirectory(workspacePath, workspacePath)
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
  }, [workspacePath])

  useEffect(() => {
    if (!openRequest || openRequest.root !== workspacePath) return
    void openRequestedFile(openRequest.path, false)
  }, [openRequest?.id, workspacePath])

  function setDirectoryLoading(path: string, loading: boolean) {
    setLoadingDirs((value) => {
      const next = new Set(value)
      if (loading) next.add(path)
      else next.delete(path)
      return next
    })
  }

  function commitDirectory(requestedPath: string, directory: WorkspaceDirectory) {
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

  async function loadDirectory(path: string) {
    const requestId = directoryRequestRef.current
    setTreeError('')
    setDirectoryLoading(path, true)
    try {
      const directory = await listWorkspaceDirectory(workspacePath, path)
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
    void openRequestedFile(entry.path)
  }

  async function openRequestedFile(path: string, remember = true) {
    setSelectedPath(path)
    if (remember) onRememberOpenPath(workspacePath, path)
    setPreview(null)
    setPreviewError('')
    setPreviewLoading(true)
    const parent = directoryPath(path)
    if (parent && !isSamePath(parent, workspacePath) && !directories[parent]) {
      onExpandedPathsChange((paths) => paths.includes(parent) ? paths : [...paths, parent])
      void loadDirectory(parent)
    }
    const requestId = ++previewRequestRef.current
    try {
      const result = await previewWorkspaceFile(workspacePath, path)
      if (!mountedRef.current || requestId !== previewRequestRef.current) return
      setPreview(result)
    } catch (err) {
      if (!mountedRef.current || requestId !== previewRequestRef.current) return
      setPreviewError((err as Error).message)
    } finally {
      if (!mountedRef.current || requestId !== previewRequestRef.current) return
      setPreviewLoading(false)
    }
  }

  async function openWorkspaceInVSCode() {
    try {
      await openWorkspacePathInVSCode(workspacePath)
    } catch (err) {
      setTreeError((err as Error).message)
    }
  }

  async function openSelectedInVSCode() {
    if (!selectedPath) return
    try {
      await openWorkspacePathInVSCode(workspacePath, selectedPath)
    } catch (err) {
      setPreviewError((err as Error).message)
    }
  }

  async function saveSelectedFile(path: string, content: string, expectedModifiedAt?: number): Promise<WorkspacePreview> {
    const approved = await onRequestFileSaveApproval({
      path,
      root: workspacePath,
      relativePath: workspaceBreadcrumbs(workspacePath, path).join('/'),
    })
    if (!approved) throw new Error('已取消保存。')
    setPreviewError('')
    const nextPreview = await saveWorkspaceFile(workspacePath, path, content, expectedModifiedAt, sessionId)
    setPreview(nextPreview)
    onWorkspaceArtifactsChanged()
    const parent = directoryPath(path)
    if (parent) void loadDirectory(parent)
    return nextPreview
  }

  function refreshTree() {
    void loadDirectory(workspacePath)
    if (selectedPath) openFile({
      name: lastPathSegment(selectedPath),
      path: selectedPath,
      relativePath: selectedPath,
      kind: 'file',
    })
  }

  const rootInfo = directories[workspacePath]
  const loadingRoot = loadingDirs.has(workspacePath)
  const normalizedFilter = normalizeWorkspaceFilter(filterText)
  const rootHasVisibleEntries = rootInfo
    ? rootInfo.entries.some((entry) => workspaceEntryMatchesFilter(entry, directories, normalizedFilter))
    : false

  return (
    <div className={`workspace-files ${navigatorCollapsed ? 'navigator-collapsed' : ''}`}>
      <WorkspacePreviewPane
        preview={preview}
        loading={previewLoading}
        error={previewError}
        selectedPath={selectedPath}
        workspacePath={workspacePath}
        onOpenInVSCode={openSelectedInVSCode}
        onSaveFile={saveSelectedFile}
        onTipChange={onTipChange}
      />
      <aside className="workspace-files-navigator" aria-label="文件管理" aria-expanded={!navigatorCollapsed}>
        <button
          {...transientTriggerProps()}
          className="workspace-files-navigator-rail"
          type="button"
          aria-label={navigatorCollapsed ? '展开文件管理' : '折叠文件管理'}
          aria-expanded={!navigatorCollapsed}
          onClick={() => onNavigatorCollapsedChange(!navigatorCollapsed)}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(navigatorCollapsed ? '展开文件管理' : '折叠文件管理', event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(navigatorCollapsed ? '展开文件管理' : '折叠文件管理', event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(navigatorCollapsed ? '展开文件管理' : '折叠文件管理', event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <FolderGlyphIcon />
        </button>
        <div className="workspace-files-navigator-inner" {...(navigatorCollapsed ? { inert: '' } : {})}>
          <div className="workspace-files-toolbar">
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
              <button
                {...transientTriggerProps()}
                className="workspace-files-icon-btn"
                type="button"
                aria-label="折叠文件管理"
                onClick={() => onNavigatorCollapsedChange(true)}
                onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('折叠文件管理', event.clientX, event.clientY))}
                onMouseMove={(event) => onTipChange(buildFloatingHelpTip('折叠文件管理', event.clientX, event.clientY))}
                onMouseLeave={() => onTipChange(null)}
                onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('折叠文件管理', event.currentTarget))}
                onBlur={() => onTipChange(null)}
              >
                <PanelCollapseIcon />
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
        </div>
      </aside>
    </div>
  )
}
