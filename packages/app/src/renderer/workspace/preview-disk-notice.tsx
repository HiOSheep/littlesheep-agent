// "The file on disk is not what you are looking at" (UX-25 item 3).
//
// The save path refuses to overwrite a newer file, but a refusal the user only meets
// after pressing 保存 is a poor first notice. This renders the state the disk watch
// derived, with the two actions that make sense and no way to lose a draft silently.
import type { WorkspaceDiskNotice } from './preview-disk-state'

export function WorkspacePreviewDiskNotice({
  notice,
  onKeepDraft,
  onReloadFromDisk,
}: {
  notice: WorkspaceDiskNotice | null
  onKeepDraft: () => void
  onReloadFromDisk: () => void
}) {
  if (!notice) return null
  return (
    <div className="workspace-preview-disk-notice" role="status" data-tone={notice.tone}>
      <span className="workspace-preview-disk-message">{notice.message}</span>
      {notice.actions.includes('reloadFromDisk') && (
        <button type="button" className="workspace-preview-disk-action" onClick={onReloadFromDisk}>
          重新加载磁盘版本
        </button>
      )}
      {notice.actions.includes('keepDraft') && (
        <button type="button" className="workspace-preview-disk-action" onClick={onKeepDraft}>
          保留我的修改
        </button>
      )}
    </div>
  )
}
