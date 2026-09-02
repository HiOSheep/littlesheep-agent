// Task composer controls, attachments, runtime selection, and sizing.
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  type AttachmentRef
} from '../api'
import { useLinkNavigation } from '../link-navigation'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { CloseIcon, FileGlyphIcon } from '../ui/icons'
import { FadePresence } from '../ui/presence'
import { attachmentExtLabel, attachmentFileUrl, compactPath, formatFileSize, inferAttachmentKind, lastPathSegment } from '../workspace/path-utils'
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
  const navigation = useLinkNavigation()
  if (files.length === 0) return null

  return (
    <div className={`message-file-strip ${label !== '附件' ? 'result-links' : ''}`} aria-label={label}>
      <span className="message-file-strip-label">{label}</span>
      <div className="message-file-list">
        {files.map((file) => (
          <MessageFileLink
            key={`${file.action}:${file.path}`}
            file={file}
            onOpen={() => onOpenFile(file.path)}
            onOpenSystem={() => navigation.openWithSystem(file.path)}
          />
        ))}
      </div>
    </div>
  )
}

function MessageFileLink({
  file,
  onOpen,
  onOpenSystem,
}: {
  file: WorkspaceArtifactRef
  onOpen: () => void
  onOpenSystem: () => void
}) {
  const clickTimerRef = useRef<number>()

  useEffect(() => () => window.clearTimeout(clickTimerRef.current), [])

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    window.clearTimeout(clickTimerRef.current)
    if (event.detail === 0) {
      onOpen()
      return
    }
    if (event.detail > 1) return
    clickTimerRef.current = window.setTimeout(onOpen, 230)
  }

  function handleDoubleClick() {
    window.clearTimeout(clickTimerRef.current)
    onOpenSystem()
  }

  return (
    <button
      className={`message-file-card ${file.action}`}
      type="button"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      <span className="message-file-icon" aria-hidden="true">
        <FileGlyphIcon name={file.name} />
      </span>
      <span className="message-file-main">
        <strong>{file.name}</strong>
        <small>{fileActionLabel(file.action)} · {compactPath(file.path)}</small>
      </span>
    </button>
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
  const lineComments = file.lineComments ?? []
  const tip = [
    name,
    file.contextPath ?? file.path,
    ...lineComments.map((comment) => {
      const range = comment.endLine && comment.endLine !== comment.startLine
        ? `${comment.startLine}-${comment.endLine}`
        : String(comment.startLine)
      return `第 ${range} 行：${comment.text}`
    }),
  ].join('\n')
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false)

  function handleOpen() {
    onTipChange(null)
    if (isImage) {
      setImagePreviewOpen(true)
      return
    }
    onOpen()
  }

  return (
    <>
      <div className={`attachment-preview-card ${isImage ? 'image' : 'file'}`}>
        <button
          className="attachment-preview-open"
          type="button"
          aria-label={isImage ? `查看原图：${name}` : tip}
          onClick={handleOpen}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(tip, event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(tip, event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          {isImage ? (
            <img className="attachment-preview-thumb" src={attachmentFileUrl(file.path)} alt="" />
          ) : (
            <>
              <div className="attachment-preview-file-icon">{attachmentExtLabel(name)}</div>
              <div className="attachment-preview-meta">
                <span>{name}</span>
                <small>{lineComments.length > 0 ? `${lineComments.length} 条行评论` : formatFileSize(file.size)}</small>
              </div>
            </>
          )}
        </button>
        <button
          className="attachment-preview-remove"
          type="button"
          aria-label={`移除 ${name}`}
          onClick={() => {
            onTipChange(null)
            onRemove()
          }}
        >
          <CloseIcon />
        </button>
      </div>
      {isImage && (
        <AttachmentImagePreview
          fileUrl={attachmentFileUrl(file.path)}
          name={name}
          open={imagePreviewOpen}
          onClose={() => setImagePreviewOpen(false)}
        />
      )}
    </>
  )
}


const ATTACHMENT_IMAGE_PREVIEW_MOTION_MS = 220


function AttachmentImagePreview({
  fileUrl,
  name,
  open,
  onClose,
}: {
  fileUrl: string
  name: string
  open: boolean
  onClose: () => void
}) {
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  return createPortal(
    <FadePresence
      show={open}
      exitMs={ATTACHMENT_IMAGE_PREVIEW_MOTION_MS}
      className="attachment-image-preview-presence"
    >
      <div
        className="attachment-image-preview-layer"
        role="presentation"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <section
          className="attachment-image-preview-surface"
          role="dialog"
          aria-modal="true"
          aria-label={`原图预览：${name}`}
        >
          <img src={fileUrl} alt={name} draggable={false} />
          <button
            className="attachment-image-preview-close"
            type="button"
            aria-label="关闭原图预览"
            autoFocus
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </section>
      </div>
    </FadePresence>,
    document.body,
  )
}


export function formatUserMessage(text: string, attachments: AttachmentRef[]): string {
  if (attachments.length === 0) return text
  return text || '已上传附件。'
}
