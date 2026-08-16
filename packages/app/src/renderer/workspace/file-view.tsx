// Owns one workspace file's cached loading, approved save transaction, and preview handoff.
import { useEffect, useRef, useState } from 'react'
import {
  openWorkspacePathInVSCode,
  saveWorkspaceFile,
  type AttachmentRef,
  type WorkspacePreview,
} from '../api'
import type { FloatingHelpTip } from '../ui/floating-help'
import type { WorkspaceFileDraftState, WorkspaceFileTabId } from '../workspace-persistence'
import { workspaceFilePreviewCache } from './file-preview-cache'
import type { WorkspaceLineComment } from './line-comments'
import { workspaceBreadcrumbs } from './path-utils'
import { WorkspacePreviewPane } from './preview-pane'

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
  onAddAttachment,
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
  onAddAttachment: (attachment: AttachmentRef) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [preview, setPreview] = useState<WorkspacePreview | null>(() => (
    workspaceFilePreviewCache.read(root, path)
  ))
  const [loading, setLoading] = useState(() => !workspaceFilePreviewCache.read(root, path))
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  useEffect(() => {
    let alive = true
    const requestId = ++requestRef.current
    const cached = workspaceFilePreviewCache.read(root, path)
    setPreview(cached)
    setError('')
    setLoading(!cached)
    workspaceFilePreviewCache.load(root, path)
      .then((result) => {
        if (!alive || requestId !== requestRef.current) return
        setPreview(result)
      })
      .catch((err) => {
        if (!alive || requestId !== requestRef.current) return
        setError((err as Error).message)
      })
      .finally(() => {
        if (!alive || requestId !== requestRef.current) return
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [root, path])

  async function openInVSCode() {
    try {
      await openWorkspacePathInVSCode(root, path)
    } catch (err) {
      setError((err as Error).message)
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
      onDraftChange={onDraftChange}
      comments={comments}
      onCommentsChange={onCommentsChange}
      onAddAttachment={onAddAttachment}
      onTipChange={onTipChange}
    />
  )
}
