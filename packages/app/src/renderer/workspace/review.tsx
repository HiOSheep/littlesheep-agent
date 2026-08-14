// Owns workspace Git review data loading, selection, refresh, and view composition.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  type WorkspaceReviewFileDiff,
  type WorkspaceReviewSnapshot,
} from '../api'
import {
  WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY,
  readBooleanPreference,
  writeBooleanPreference,
} from '../app-shell/preferences'
import { FloatingHelpTip } from '../ui/floating-help'
import { WorkspacePlaceholder } from './placeholder'
import { isSamePath } from './path-utils'
import {
  buildWorkspaceReviewTree,
  collectWorkspaceReviewFolderPaths,
  filterWorkspaceReviewFiles,
  filterWorkspaceReviewTree,
  navigateWorkspaceReviewPath,
  selectWorkspaceReviewPath,
} from './review-model'
import { WorkspaceReviewDiff } from './review-diff'
import { WorkspaceReviewTree } from './review-tree'
import { preloadWorkspaceCodeEditor } from './code-editor'
import { workspaceReviewCache } from './review-cache'

const REVIEW_REFRESH_INTERVAL_MS = 30_000

export function WorkspaceReview({
  workspacePath,
  artifactVersion,
  fileNavigatorCollapsed,
  onFileNavigatorCollapsedChange,
  onOpenFile,
  onTipChange,
}: {
  workspacePath: string
  artifactVersion: number
  fileNavigatorCollapsed: boolean
  onFileNavigatorCollapsedChange: (collapsed: boolean) => void
  onOpenFile: (path: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [filterText, setFilterText] = useState('')
  const [sideBySide, setSideBySide] = useState(() => (
    readBooleanPreference(WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY, true)
  ))
  const [snapshotRefresh, setSnapshotRefresh] = useState({ force: false, version: 0 })
  const [snapshot, setSnapshot] = useState<WorkspaceReviewSnapshot | null>(
    () => workspaceReviewCache.readSnapshot(workspacePath),
  )
  const [loading, setLoading] = useState(() => !workspaceReviewCache.readSnapshot(workspacePath))
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(() => (
    selectWorkspaceReviewPath(workspaceReviewCache.readSnapshot(workspacePath)?.files ?? [], null)
  ))
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => (
    new Set(collectWorkspaceReviewFolderPaths(
      buildWorkspaceReviewTree(workspaceReviewCache.readSnapshot(workspacePath)?.files ?? []),
    ))
  ))
  const [diff, setDiff] = useState<WorkspaceReviewFileDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState('')
  const snapshotRequestRef = useRef(0)
  const diffRequestRef = useRef(0)
  const artifactVersionRef = useRef(artifactVersion)
  const completedRefreshVersionRef = useRef(0)
  const snapshotInFlightRef = useRef(false)
  const queuedRefreshRef = useRef<boolean | null>(null)
  const refreshScopeRef = useRef(workspacePath)
  const requestSnapshotRefresh = useCallback((force = false) => {
    if (snapshotInFlightRef.current) {
      queuedRefreshRef.current = Boolean(queuedRefreshRef.current || force)
      return
    }
    setSnapshotRefresh((current) => ({ force, version: current.version + 1 }))
  }, [])

  useEffect(() => {
    writeBooleanPreference(WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY, sideBySide)
  }, [sideBySide])

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') requestSnapshotRefresh(false)
    }, REVIEW_REFRESH_INTERVAL_MS)
    const handleFocus = () => requestSnapshotRefresh(false)
    window.addEventListener('focus', handleFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
    }
  }, [requestSnapshotRefresh])

  useEffect(() => {
    if (artifactVersionRef.current === artifactVersion) return
    artifactVersionRef.current = artifactVersion
    requestSnapshotRefresh(true)
  }, [artifactVersion, requestSnapshotRefresh])

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    const requestId = ++snapshotRequestRef.current
    if (!isSamePath(refreshScopeRef.current, workspacePath)) {
      refreshScopeRef.current = workspacePath
      queuedRefreshRef.current = null
    }
    snapshotInFlightRef.current = true
    const cached = workspaceReviewCache.readSnapshot(workspacePath)
    const hasSnapshot = Boolean(cached || (snapshot && isSamePath(snapshot.workspacePath, workspacePath)))
    const force = snapshotRefresh.version > completedRefreshVersionRef.current && snapshotRefresh.force
    if (cached?.availability === 'ready' && cached.files.length > 0) {
      void preloadWorkspaceCodeEditor().catch(() => undefined)
    }
    setError('')
    if (cached) {
      setSnapshot(cached)
      setSelectedPath((current) => selectWorkspaceReviewPath(cached.files, current))
      setLoading(false)
      setRefreshing(true)
    } else if (hasSnapshot) {
      setRefreshing(true)
    } else {
      setSnapshot(null)
      setSelectedPath(null)
      setExpandedFolders(new Set())
      setDiff(null)
      setLoading(true)
    }
    workspaceReviewCache.loadSnapshot(workspacePath, { force, signal: controller.signal })
      .then((result) => {
        if (!alive || requestId !== snapshotRequestRef.current) return
        if (result.availability === 'ready' && result.files.length > 0) {
          void preloadWorkspaceCodeEditor().catch(() => undefined)
        }
        setSnapshot(result)
        completedRefreshVersionRef.current = Math.max(completedRefreshVersionRef.current, snapshotRefresh.version)
        setSelectedPath((current) => selectWorkspaceReviewPath(result.files, current))
        if (!hasSnapshot) {
          setExpandedFolders(new Set(collectWorkspaceReviewFolderPaths(buildWorkspaceReviewTree(result.files))))
        }
      })
      .catch((reason) => {
        if (
          alive
          && requestId === snapshotRequestRef.current
          && (reason as Error).name !== 'AbortError'
          && !hasSnapshot
        ) setError((reason as Error).message)
      })
      .finally(() => {
        if (requestId !== snapshotRequestRef.current) return
        snapshotInFlightRef.current = false
        const queuedRefresh = queuedRefreshRef.current
        queuedRefreshRef.current = null
        if (!alive) return
        setLoading(false)
        setRefreshing(false)
        if (queuedRefresh !== null) requestSnapshotRefresh(queuedRefresh)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [requestSnapshotRefresh, snapshotRefresh, workspacePath])

  const selectedRevision = snapshot?.revision ?? ''

  useEffect(() => {
    if (
      !snapshot
      || !isSamePath(snapshot.workspacePath, workspacePath)
      || !selectedPath
      || !snapshot.files.some((file) => file.path === selectedPath)
    ) {
      setDiff(null)
      setDiffError('')
      setDiffLoading(false)
      return
    }
    let alive = true
    const controller = new AbortController()
    const requestId = ++diffRequestRef.current
    const cached = workspaceReviewCache.readDiff(workspacePath, selectedPath, selectedRevision)
    const stale = diff
      && diff.file.path === selectedPath
      && isSamePath(diff.workspacePath, workspacePath)
      ? diff
      : null
    setDiff(cached ?? stale)
    setDiffLoading(!cached && !stale)
    setDiffError('')
    workspaceReviewCache.loadDiff(workspacePath, selectedPath, selectedRevision, { signal: controller.signal })
      .then((result) => {
        if (alive && requestId === diffRequestRef.current) setDiff(result)
      })
      .catch((reason) => {
        if (!alive || requestId !== diffRequestRef.current || (reason as Error).name === 'AbortError') return
        if ((reason as { status?: number }).status === 409) {
          requestSnapshotRefresh(true)
          return
        }
        if (!cached && !stale) {
          setDiff(null)
          setDiffError((reason as Error).message)
        }
      })
      .finally(() => {
        if (alive && requestId === diffRequestRef.current) setDiffLoading(false)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [selectedPath, selectedRevision, requestSnapshotRefresh, workspacePath])

  const tree = useMemo(() => buildWorkspaceReviewTree(snapshot?.files ?? []), [snapshot?.files])
  const filteredFiles = useMemo(
    () => filterWorkspaceReviewFiles(snapshot?.files ?? [], filterText),
    [snapshot?.files, filterText],
  )
  const filteredTree = useMemo(() => filterWorkspaceReviewTree(tree, filterText), [tree, filterText])
  useEffect(() => {
    if (!filterText.trim()) return
    setSelectedPath((current) => selectWorkspaceReviewPath(filteredFiles, current))
  }, [filterText, filteredFiles])

  const handleFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setFilterText('')
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return
    event.preventDefault()
    if (filteredFiles.length === 0) return
    setSelectedPath(navigateWorkspaceReviewPath(
      filteredFiles,
      selectedPath,
      event.key === 'Enter' ? 0 : event.key === 'ArrowUp' ? -1 : 1,
    ))
  }

  const selectedFile = snapshot?.files.find((file) => file.path === selectedPath) ?? null
  const selectedDiff = diff
    && selectedFile
    && diff.file.path === selectedFile.path
    && isSamePath(diff.workspacePath, workspacePath)
    ? diff
    : null
  const branchLabel = snapshot?.branch ?? 'Git'
  const repositoryLabel = snapshot?.upstream ? `${branchLabel} -> ${snapshot.upstream}` : branchLabel
  const snapshotReady = snapshot?.availability === 'ready'
  const emptyState = loading && !snapshot
    ? <WorkspacePlaceholder title="读取 Git 状态" text="正在整理当前工作区更改。" />
    : !loading && error
      ? <WorkspacePlaceholder title="Git 审阅失败" text={error} />
      : !loading && !error && snapshot && !snapshotReady
        ? <WorkspacePlaceholder title="Git 审阅不可用" text={snapshot.message ?? '当前工作区无法读取 Git 状态。'} />
        : !loading && !error && snapshotReady && snapshot.files.length === 0
          ? <WorkspacePlaceholder title="没有未提交更改" text="工作区与 HEAD 一致。" />
          : undefined

  return (
    <div className={`workspace-review workspace-files ${fileNavigatorCollapsed ? 'navigator-collapsed' : ''}`}>
      <div className="workspace-review-content">
        <WorkspaceReviewDiff
          file={selectedFile}
          diff={selectedDiff}
          sideBySide={sideBySide}
          emptyState={emptyState}
          loading={diffLoading}
          error={diffError}
          onSideBySideChange={setSideBySide}
          onOpenFile={() => selectedFile && onOpenFile(selectedFile.absolutePath)}
          onTipChange={onTipChange}
        />
      </div>
      <WorkspaceReviewTree
        workspacePath={workspacePath}
        repositoryLabel={repositoryLabel}
        ahead={snapshot?.ahead ?? 0}
        behind={snapshot?.behind ?? 0}
        nodes={filteredTree}
        fileCount={filteredFiles.length}
        totalFileCount={snapshot?.totalFiles ?? 0}
        filesTruncated={snapshot?.filesTruncated ?? false}
        countsComplete={snapshot?.countsComplete ?? false}
        additions={filteredFiles.reduce((total, file) => total + file.additions, 0)}
        deletions={filteredFiles.reduce((total, file) => total + file.deletions, 0)}
        selectedPath={selectedPath}
        expandedFolders={expandedFolders}
        filterText={filterText}
        refreshing={refreshing}
        navigatorCollapsed={fileNavigatorCollapsed}
        emptyText={filterText.trim() ? '没有匹配的更改' : snapshotReady ? '没有未提交更改' : '正在读取 Git 更改...'}
        onFilterTextChange={setFilterText}
        onFilterKeyDown={handleFilterKeyDown}
        onRefresh={() => requestSnapshotRefresh(true)}
        onToggleFolder={(path) => setExpandedFolders((current) => {
          const next = new Set(current)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        })}
        onSelectFile={setSelectedPath}
        onNavigatorCollapsedChange={onFileNavigatorCollapsedChange}
        onTipChange={onTipChange}
      />
    </div>
  )
}
