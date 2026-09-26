// Owns the review file-diff read: its cache, its retry identity and the bounded conflict loop.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceReviewFileDiff, WorkspaceReviewSnapshot } from '../api'
import { isSamePath } from './path-utils'
import { workspaceReviewCache } from './review-cache'
import { workspaceErrorMessage } from './workspace-errors'

/**
 * How many automatic re-reads one conflicting diff may trigger before the surface stops
 * refreshing and asks the user to try again. A 409 means the repository moved between the
 * snapshot and the diff read, so a re-read is right; re-reading for ever is not.
 */
export const MAX_DIFF_CONFLICT_REFRESHES = 2

export interface WorkspaceReviewDiffSurface {
  diff: WorkspaceReviewFileDiff | null
  diffError: string
  diffLoading: boolean
  /** Clears the conflict budget: any user-initiated retry starts a new attempt. */
  resetConflictBudget: () => void
  /** Re-reads the selected diff after clearing the conflict budget. */
  retryDiff: () => void
}

export function useWorkspaceReviewDiff({
  workspacePath,
  workspaceSnapshot,
  selectedPath,
  requestSnapshotRefresh,
}: {
  workspacePath: string
  workspaceSnapshot: WorkspaceReviewSnapshot | null
  selectedPath: string | null
  /** A conflict means the diff was read against a snapshot that is already gone. */
  requestSnapshotRefresh: (force?: boolean) => void
}): WorkspaceReviewDiffSurface {
  const [diff, setDiff] = useState<WorkspaceReviewFileDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState('')
  const [retryVersion, setRetryVersion] = useState(0)
  const requestRef = useRef(0)
  const handledRetryRef = useRef(0)
  const conflictRef = useRef(0)
  const selectedRevision = workspaceSnapshot?.revision ?? ''
  const resetConflictBudget = useCallback(() => { conflictRef.current = 0 }, [])
  const retryDiff = useCallback(() => {
    conflictRef.current = 0
    setRetryVersion((version) => version + 1)
  }, [])

  useEffect(() => {
    if (
      !workspaceSnapshot
      || !isSamePath(workspaceSnapshot.workspacePath, workspacePath)
      || !selectedPath
      || !workspaceSnapshot.files.some((file) => file.path === selectedPath)
    ) {
      setDiff(null)
      setDiffError('')
      setDiffLoading(false)
      return
    }
    let alive = true
    const controller = new AbortController()
    const requestId = ++requestRef.current
    const cached = workspaceReviewCache.readDiff(workspacePath, selectedPath, selectedRevision)
    const stale = diff
      && diff.file.path === selectedPath
      && isSamePath(diff.workspacePath, workspacePath)
      ? diff
      : null
    const force = retryVersion > handledRetryRef.current
    handledRetryRef.current = retryVersion
    setDiff(cached ?? stale)
    // "Loading" means a request is in flight, so stale content under a refresh can
    // say it is being refreshed instead of looking like a fresh result. A cache hit
    // with no forced re-read never leaves this process.
    setDiffLoading(force || !cached)
    setDiffError('')
    workspaceReviewCache.loadDiff(workspacePath, selectedPath, selectedRevision, {
      force,
      signal: controller.signal,
    })
      .then((result) => {
        if (!alive || requestId !== requestRef.current) return
        conflictRef.current = 0
        setDiff(result)
      })
      .catch((reason) => {
        if (!alive || requestId !== requestRef.current || (reason as Error).name === 'AbortError') return
        if ((reason as { status?: number }).status === 409) {
          conflictRef.current += 1
          if (conflictRef.current <= MAX_DIFF_CONFLICT_REFRESHES) requestSnapshotRefresh(true)
          else setDiffError('文件在读取差异时持续变化，已停止自动刷新。请等修改完成后手动重试。')
          return
        }
        console.debug('[workspace-review] review diff request failed', reason)
        setDiffError(workspaceErrorMessage(reason, '文件差异暂时无法读取，请稍后重试。'))
      })
      .finally(() => {
        if (alive && requestId === requestRef.current) setDiffLoading(false)
      })
    return () => {
      alive = false
      controller.abort()
    }
  }, [selectedPath, selectedRevision, retryVersion, requestSnapshotRefresh, workspacePath])

  return { diff, diffError, diffLoading, resetConflictBudget, retryDiff }
}
