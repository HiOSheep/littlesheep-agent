// Task composer controls, attachments, runtime selection, and sizing.
import {
type AttachmentRef
} from '../api'
import { FloatingHelpTip,buildFloatingHelpTip,buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FileGlyphIcon } from '../ui/icons'
import { attachmentExtLabel,attachmentFileUrl,compactPath,formatFileSize,inferAttachmentKind,lastPathSegment } from '../workspace/path-utils'
import { WorkspaceArtifactRef } from '../workspace/types'


export function MessageFileStrip({
  files,
  label,
  onOpenFile,
}: {
  files: WorkspaceArtifactRef[]
  label: string
  onOpenFile: (path: string) => void
}) {
  if (files.length === 0) return null

  return (
    <div className="message-file-strip" aria-label={label}>
      <span className="message-file-strip-label">{label}</span>
      <div className="message-file-list">
        {files.map((file) => (
          <button
            key={`${file.action}:${file.path}`}
            className={`message-file-card ${file.action}`}
            type="button"
            onClick={() => onOpenFile(file.path)}
          >
            <span className="message-file-icon" aria-hidden="true">
              <FileGlyphIcon />
            </span>
            <span className="message-file-main">
              <strong>{file.name}</strong>
              <small>{fileActionLabel(file.action)} · {compactPath(file.path)}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}


export function fileActionLabel(action: WorkspaceArtifactRef['action']): string {
  if (action === 'attached') return '附件'
  return action === 'created' ? '新建' : '修改'
}


export function AttachmentPreviewCard({
  file,
  onOpen,
  onRemove,
  onTipChange,
}: {
  file: AttachmentRef
  onOpen: () => void
  onRemove: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const name = file.name ?? lastPathSegment(file.path)
  const kind = file.kind ?? inferAttachmentKind(name || file.path)
  const isImage = kind === 'image'
  const tip = `${name}\n${file.path}`

  return (
    <div
      className={`attachment-preview-card ${isImage ? 'image' : 'file'}`}
      tabIndex={0}
      role="button"
      aria-label={tip}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen()
      }}
      onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
      onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
      onMouseLeave={() => onTipChange(null)}
      onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
      onBlur={() => onTipChange(null)}
    >
      <button
        className="attachment-preview-remove"
        type="button"
        aria-label={`移除 ${name}`}
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
      >
        ×
      </button>
      {isImage ? (
        <img className="attachment-preview-thumb" src={attachmentFileUrl(file.path)} alt="" />
      ) : (
        <div className="attachment-preview-file-icon">{attachmentExtLabel(name)}</div>
      )}
      <div className="attachment-preview-meta">
        <span>{name}</span>
        <small>{formatFileSize(file.size)}</small>
      </div>
    </div>
  )
}


export function formatUserMessage(text: string, attachments: AttachmentRef[]): string {
  if (attachments.length === 0) return text
  return text || '已上传附件。'
}
