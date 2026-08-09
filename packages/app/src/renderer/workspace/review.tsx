// Owns workspace Git review data loading, selection, refresh, and view composition.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  getWorkspaceReview,
  getWorkspaceReviewDiff,
  type WorkspaceReviewFileDiff,
  type WorkspaceReviewSnapshot,
} from '../api'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { RefreshIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import { WorkspacePlaceholder } from './placeholder'
import { isSamePath } from './path-utils'
import {
  buildWorkspaceReviewTree,
  collectWorkspaceReviewFolderPaths,
  selectWorkspaceReviewPath,
} from './review-model'
import { WorkspaceReviewDiff } from './review-diff'
import { WorkspaceReviewTree } from './review-tree'

const REVIEW_REFRESH_INTERVAL_MS = 30_000

function fileRevision(file: WorkspaceReviewSnapshot['files'][number] | undefined): string {
  return file
    ? JSON.stringify([
        file.path,
        file.absolutePath,
        file.oldPath,
        file.status,
        file.additions,
        file.deletions,
        file.countAvailable,
        file.staged,
        file.unstaged,
        file.binary,
      ])
    : ''
}

export function WorkspaceReview({
  workspacePath,
  artifactVersion,
  activityView,
  onOpenFile,
  onTipChange,
}: {
  workspacePath: string
  artifactVersion: number
  activityView: ReactNode
  onOpenFile: (path: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [view, setView] = useState<'changes' | 'activity'>('changes')
  const [snapshotRefreshVersion, setSnapshotRefreshVersion] = useState(0)
  const [diffRefreshVersion, setDiffRefreshVersion] = useState(0)
  const [snapshot, setSnapshot] = useState<WorkspaceReviewSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [diff, setDiff] = useState<WorkspaceReviewFileDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState('')
  const snapshotControllerRef = useRef<AbortController | null>(null)
  const diffControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (view !== 'changes') return
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        setSnapshotRefreshVersion((value) => value + 1)
      }
    }, REVIEW_REFRESH_INTERVAL_MS)
    const handleFocus = () => {
      setSnapshotRefreshVersion((value) => value + 1)
    }
    window.addEventListener('focus', handleFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
    }
  }, [view])

  useEffect(() => {
    if (view !== 'changes') return
    const controller = new AbortController()
    snapshotControllerRef.current = controller
    diffControllerRef.current?.abort()
    diffControllerRef.current = null
    const hasSnapshot = snapshot ? isSamePath(snapshot.workspacePath, workspacePath) : false
    setError('')
    if (hasSnapshot) setRefreshing(true)
    else {
      setSnapshot(null)
      setSelectedPath(null)
      setExpandedFolders(new Set())
      setDiff(null)
      setLoading(true)
    }
    getWorkspaceReview(workspacePath, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return
        if (snapshotControllerRef.current === controller) snapshotControllerRef.current = null
        setSnapshot(result)
        setSelectedPath((current) => selectWorkspaceReviewPath(result.files, current))
        const tree = buildWorkspaceReviewTree(result.files)
        if (!hasSnapshot) {
          setExpandedFolders(new Set(collectWorkspaceReviewFolderPaths(tree)))
        }
        setDiffRefreshVersion((value) => value + 1)
      })
      .catch((reason) => {
        if (!controller.signal.aborted && (reason as Error).name !== 'AbortError') {
          setError((reason as Error).message)
        }
      })
      .finally(() => {
        if (controller.signal.aborted) return
        if (snapshotControllerRef.current === controller) snapshotControllerRef.current = null
        setLoading(false)
        setRefreshing(false)
      })
    return () => {
      controller.abort()
      if (snapshotControllerRef.current === controller) snapshotControllerRef.current = null
    }
  }, [workspacePath, artifactVersion, snapshotRefreshVersion, view])

  useEffect(() => {
    if (
      view !== 'changes'
      || snapshotControllerRef.current
      || !snapshot
      || !isSamePath(snapshot.workspacePath, workspacePath)
      || !selectedPath
      || !snapshot.files.some((file) => file.path === selectedPath)
    ) {
      setDiff(null)
      setDiffError('')
      setDiffLoading(false)
      return
    }
    const controller = new AbortController()
    diffControllerRef.current = controller
    setDiff(null)
    setDiffLoading(true)
    setDiffError('')
    getWorkspaceReviewDiff(workspacePath, selectedPath, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setDiff(result)
      })
      .catch((reason) => {
        if (!controller.signal.aborted && (reason as Error).name !== 'AbortError') {
          setDiff(null)
          setDiffError((reason as Error).message)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          if (diffControllerRef.current === controller) diffControllerRef.current = null
          setDiffLoading(false)
        }
      })
    return () => {
      controller.abort()
      if (diffControllerRef.current === controller) diffControllerRef.current = null
    }
  }, [
    selectedPath,
    fileRevision(snapshot?.files.find((file) => file.path === selectedPath)),
    diffRefreshVersion,
    view,
    workspacePath,
  ])

  const tree = useMemo(() => buildWorkspaceReviewTree(snapshot?.files ?? []), [snapshot?.files])
  const selectedFile = snapshot?.files.find((file) => file.path === selectedPath) ?? null
  const selectedDiff = diff
    && selectedFile
    && diff.file.path === selectedFile.path
    && isSamePath(diff.workspacePath, workspacePath)
    ? diff
    : null
  const branchLabel = snapshot?.branch ?? 'Git'
  const repositoryLabel = snapshot?.upstream
    ? `${branchLabel} -> ${snapshot.upstream}`
    : branchLabel

  return (
    <div className="workspace-review">
      <header className="workspace-review-toolbar">
        <div className="workspace-review-view-switch" role="tablist" aria-label="审阅视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'changes'}
            className={view === 'changes' ? 'active' : ''}
            onClick={() => setView('changes')}
          >
            更改
            {snapshot?.availability === 'ready' && <small>{snapshot.totalFiles}</small>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'activity'}
            className={view === 'activity' ? 'active' : ''}
            onClick={() => setView('activity')}
          >
            现场
          </button>
        </div>
        {view === 'changes' && (
          <div className="workspace-review-repository-meta">
            <span title={repositoryLabel}>{repositoryLabel}</span>
            {snapshot?.ahead ? <small>领先 {snapshot.ahead}</small> : null}
            {snapshot?.behind ? <small>落后 {snapshot.behind}</small> : null}
          </div>
        )}
        {view === 'changes' && (
          <button
            {...transientTriggerProps()}
            className={`workspace-review-icon-button ${refreshing ? 'refreshing' : ''}`}
            type="button"
            aria-label="刷新 Git 更改"
            disabled={loading || refreshing}
            onClick={() => setSnapshotRefreshVersion((value) => value + 1)}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新 Git 更改', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新 Git 更改', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新 Git 更改', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            <RefreshIcon />
          </button>
        )}
      </header>

      {view === 'activity' ? (
        <div className="workspace-review-activity">{activityView}</div>
      ) : (
        <div className="workspace-review-content">
          {loading && !snapshot && <WorkspacePlaceholder title="读取 Git 状态" text="正在整理当前工作区更改。" />}
          {!loading && error && <WorkspacePlaceholder title="Git 审阅失败" text={error} />}
          {!loading && !error && snapshot?.availability !== 'ready' && (
            <WorkspacePlaceholder title="Git 审阅不可用" text={snapshot?.message ?? '当前工作区无法读取 Git 状态。'} />
          )}
          {!loading && !error && snapshot?.availability === 'ready' && snapshot.files.length === 0 && (
            <WorkspacePlaceholder title="没有未提交更改" text="工作区与 HEAD 一致。" />
          )}
          {!error && snapshot?.availability === 'ready' && snapshot.files.length > 0 && (
            <div className="workspace-review-layout">
              <WorkspaceReviewTree
                nodes={tree}
                fileCount={snapshot.files.length}
                totalFileCount={snapshot.totalFiles}
                filesTruncated={snapshot.filesTruncated}
                countsComplete={snapshot.countsComplete}
                additions={snapshot.additions}
                deletions={snapshot.deletions}
                selectedPath={selectedPath}
                expandedFolders={expandedFolders}
                onToggleFolder={(path) => setExpandedFolders((current) => {
                  const next = new Set(current)
                  if (next.has(path)) next.delete(path)
                  else next.add(path)
                  return next
                })}
                onSelectFile={setSelectedPath}
              />
              <WorkspaceReviewDiff
                file={selectedFile}
                diff={selectedDiff}
                loading={diffLoading}
                error={diffError}
                onOpenFile={() => selectedFile && onOpenFile(selectedFile.absolutePath)}
                onTipChange={onTipChange}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
