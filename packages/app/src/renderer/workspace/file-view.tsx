// Owns one workspace file's cached loading, approved save transaction, and preview handoff.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  openWorkspacePathInVSCode,
  saveWorkspaceFile,
  statWorkspaceFile,
  type AttachmentRef,
  type WorkspacePreview,
} from '../api'
import type { FloatingHelpTip } from '../ui/floating-help'
import type { WorkspaceFileDraftState, WorkspaceFileTabId } from '../workspace-persistence'
import { workspaceFilePreviewCache } from './file-preview-cache'
import { WORKSPACE_FILE_REFRESH_MS, useWorkspaceAutoRefresh } from './use-workspace-auto-refresh'
import type { WorkspaceLineComment } from './line-comments'
import { workspaceBreadcrumbs } from './path-utils'
import { WorkspacePreviewPane } from './preview-pane'
import { missingWorkspaceFileMessage, workspaceErrorMessage } from './workspace-errors'

export function WorkspaceFileView({
  tabId,
  root,
  path,
  sessionId,
  draft,
  onDraftChange,
  onRequestFileSaveApproval,
  onWorkspaceArtifactsChanged,
  onWorkspaceFileSaved,
  comments,
  onCommentsChange,
  onCommentUpdate,
  onCommentDelete,
  onAddAttachment,
  onOpenBrowserTab,
  onRevealFolder,
  active = true,
  onTipChange,
}: {
  tabId: WorkspaceFileTabId
  root: string
  path: string
  sessionId?: string
  draft?: WorkspaceFileDraftState
  onDraftChange: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  onRequestFileSaveApproval: (detail: unknown) => Promise<boolean>
  onWorkspaceArtifactsChanged: () => void
  onWorkspaceFileSaved: (root: string, path: string, preview: WorkspacePreview) => void
  comments: WorkspaceLineComment[]
  onCommentsChange: (comments: WorkspaceLineComment[]) => void
  onCommentUpdate: (previous: WorkspaceLineComment, next: WorkspaceLineComment, attachment: AttachmentRef) => void
  onCommentDelete: (comment: WorkspaceLineComment) => void
  onAddAttachment: (attachment: AttachmentRef) => void
  onOpenBrowserTab: (url: string) => void
  /** Reveals a folder of this file's path in the file navigator, so a breadcrumb can jump. */
  onRevealFolder?: (path: string) => void
  /** Whether this file's tab is the one on screen; a cached tab must not poll the disk. */
  active?: boolean
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [preview, setPreview] = useState<WorkspacePreview | null>(() => (
    workspaceFilePreviewCache.read(root, path)
  ))
  const [loading, setLoading] = useState(() => !workspaceFilePreviewCache.read(root, path))
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  const loadPreview = useCallback(async () => {
    const requestId = ++requestRef.current
    setError('')
    try {
      // A selected file must be checked against the filesystem even when its
      // cached preview is still fresh; the file may have been deleted or moved
      // after the navigator populated the cache.
      const result = await workspaceFilePreviewCache.load(root, path, { force: true })
      if (requestId !== requestRef.current) return
      setPreview(result)
    } catch (err) {
      if (requestId !== requestRef.current) return
      console.debug('[workspace-file-view] file preview request failed', err)
      const missingMessage = missingWorkspaceFileMessage(err)
      if (missingMessage) {
        workspaceFilePreviewCache.invalidate(root, path)
        setPreview(null)
        setError(missingMessage)
        return
      }
      setError(workspaceErrorMessage(err, '文件预览暂时无法读取，请稍后重试。'))
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [path, root])

  useEffect(() => {
    const cached = workspaceFilePreviewCache.read(root, path)
    setPreview(cached)
    setError('')
    setLoading(!cached)
    void loadPreview()
  }, [loadPreview, path, root])

  // `modifiedAt` is the cheap question ("did this file change?"); the tick only re-reads the file
  // when the answer changed. Unsaved edits keep their draft: the preview is not allowed to replace
  // what the reader typed, so that case still goes through the disk notice (asked for 2026-10-03).
  const previewModifiedAt = preview?.modifiedAt
  const draftIsClean = !draft || (draft.editorText === draft.savedText && !draft.editing)
  const autoReload = useCallback(async () => {
    try {
      const stat = await statWorkspaceFile(root, path)
      if (!stat.exists) return
      if (previewModifiedAt === undefined || stat.modifiedAt === previewModifiedAt) return
      if (!draftIsClean) return
      void loadPreview()
    } catch (err) {
      console.debug('[workspace-file-view] file stat probe failed', err)
    }
  }, [draftIsClean, loadPreview, path, previewModifiedAt, root])
  useWorkspaceAutoRefresh(autoReload, WORKSPACE_FILE_REFRESH_MS, active)

  async function openInVSCode() {
    try {
      await openWorkspacePathInVSCode(root, path)
    } catch (err) {
      console.debug('[workspace-file-view] opening workspace path failed', err)
      const missingMessage = missingWorkspaceFileMessage(err)
      if (missingMessage) {
        workspaceFilePreviewCache.invalidate(root, path)
        setPreview(null)
        setError(missingMessage)
        return
      }
      setError(workspaceErrorMessage(err, '无法打开当前工作区，请稍后重试。'))
    }
  }

  async function saveFile(nextPath: string, content: string, expectedModifiedAt?: number): Promise<WorkspacePreview> {
    const approved = await onRequestFileSaveApproval({
      path: nextPath,
      root,
      relativePath: workspaceBreadcrumbs(root, nextPath).join('/'),
    })
    if (!approved) throw new Error('已取消保存。')
    const nextPreview = await saveWorkspaceFile(root, nextPath, content, expectedModifiedAt, sessionId)
    workspaceFilePreviewCache.store(root, nextPath, nextPreview)
    setPreview(nextPreview)
    onWorkspaceArtifactsChanged()
    onWorkspaceFileSaved(root, nextPath, nextPreview)
    return nextPreview
  }

  return (
    <WorkspacePreviewPane
      preview={preview}
      loading={loading}
      error={error}
      selectedPath={path}
      workspacePath={root}
      sessionId={sessionId}
      tabId={tabId}
      draft={draft}
      onOpenInVSCode={openInVSCode}
      onSaveFile={saveFile}
      onOpenBrowserTab={onOpenBrowserTab}
      onReloadFromDisk={loadPreview}
      onRevealFolder={onRevealFolder}
      onDraftChange={onDraftChange}
      comments={comments}
      onCommentsChange={onCommentsChange}
      onCommentUpdate={onCommentUpdate}
      onCommentDelete={onCommentDelete}
      onAddAttachment={onAddAttachment}
      onTipChange={onTipChange}
    />
  )
}
