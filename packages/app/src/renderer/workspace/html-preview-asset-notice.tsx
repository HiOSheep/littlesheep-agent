// Why a static preview is missing a stylesheet or an image (UX-25 item 4).
//
// The frame cannot run scripts, so a failed subresource is invisible from inside it.
// Main's loopback service is the witness: it records every refusal with the path it
// was asked for and the status it answered, and this notice turns that into one
// compact line plus an expandable list, with a retry that rebuilds the frame.
import { useState } from 'react'
import type { WorkspacePreviewAssetFailure } from '../api/workspace-preview-server'

export function WorkspacePreviewAssetNotice({
  failures,
  onRetry,
}: {
  failures: WorkspacePreviewAssetFailure[]
  onRetry: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  if (failures.length === 0) return null
  const unique = [...new Map(failures.map((failure) => [`${failure.path}\0${failure.status}`, failure])).values()]

  return (
    <div className="workspace-preview-asset-notice" role="status">
      <button
        type="button"
        className="workspace-preview-asset-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {unique.length} 个资源未能加载{expanded ? '（收起）' : '（查看详情）'}
      </button>
      <button type="button" className="workspace-preview-asset-retry" onClick={onRetry}>
        重试
      </button>
      {expanded && (
        <ul className="workspace-preview-asset-list">
          {unique.map((failure) => (
            <li key={`${failure.path}-${failure.status}`}>
              <code>{failure.path}</code>
              <span>{failure.status === 403 ? '被拒绝（超出工作区范围或不可读）' : '未找到'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
