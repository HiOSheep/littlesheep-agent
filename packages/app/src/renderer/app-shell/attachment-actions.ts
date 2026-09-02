// Attachment and composer drag/drop actions owned by the app-shell controller.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { getPathForFile, importAttachment, selectAttachments, type AttachmentRef } from '../api'
import { dataTransferHasFiles, inferAttachmentKind, isSamePath, lastPathSegment } from '../workspace/path-utils'
import { lineCommentScopeMatchesAttachment, updateLineCommentAttachment, type LineCommentAttachmentRemoval } from '../workspace/line-comment-attachments'
import type { WorkspaceLineComment } from '../workspace/line-comments'

interface AttachmentActionOptions {
  appMountedRef: MutableRefObject<boolean>
  attachments: AttachmentRef[]
  setAttachments: Dispatch<SetStateAction<AttachmentRef[]>>
  setRuntimeError: Dispatch<SetStateAction<string | null>>
  setDragActive: Dispatch<SetStateAction<boolean>>
  attachmentRemovalIdRef: MutableRefObject<number>
  setAttachmentRemoval: Dispatch<SetStateAction<LineCommentAttachmentRemoval | null>>
}

export function createAttachmentActions(options: AttachmentActionOptions) {
  function mergeAttachments(files: AttachmentRef[]) {
    options.setAttachments((previous) => {
      const byPath = new Map(previous.map((file) => [file.path, file]))
      for (const file of files) byPath.set(file.path, file)
      return Array.from(byPath.values())
    })
  }

  async function addAttachments() {
    try {
      const files = await selectAttachments()
      if (!options.appMountedRef.current || files.length === 0) return
      mergeAttachments(files)
    } catch (error) {
      if (options.appMountedRef.current) options.setRuntimeError((error as Error).message)
    }
  }

  async function addAttachmentFiles(files: File[]) {
    if (files.length === 0) return
    try {
      const refs: AttachmentRef[] = []
      for (const file of files) {
        const path = getPathForFile(file) || (file as File & { path?: string }).path || ''
        refs.push(path ? { path, name: file.name || lastPathSegment(path), kind: inferAttachmentKind(file.name || path, file.type), size: file.size } : await importAttachment(file))
      }
      mergeAttachments(refs)
      if (options.appMountedRef.current) options.setRuntimeError(null)
    } catch (error) {
      if (options.appMountedRef.current) options.setRuntimeError((error as Error).message)
    }
  }

  function removeAttachment(attachment: AttachmentRef) {
    if (!options.attachments.some((file) => isSamePath(file.path, attachment.path))) return
    options.setAttachments((current) => current.filter((file) => !isSamePath(file.path, attachment.path)))
    options.setAttachmentRemoval({ id: ++options.attachmentRemovalIdRef.current, attachment })
  }

  function removeLineCommentAttachment(scope: string, comment: WorkspaceLineComment) {
    options.setAttachments((current) => {
      const previous = { id: comment.id, startLine: comment.startLine, ...(comment.endLine === undefined ? {} : { endLine: comment.endLine }), text: comment.text }
      let next = current
      for (const attachment of current) if (lineCommentScopeMatchesAttachment(scope, attachment)) next = updateLineCommentAttachment(next, { attachment, previous, next: null })
      return next
    })
  }

  function updatePublishedLineCommentAttachment(scope: string, previous: WorkspaceLineComment, next: WorkspaceLineComment, attachment: AttachmentRef) {
    const nextAttachmentComment = attachment.lineComments?.find((item) => item.id === next.id) ?? { id: next.id, startLine: next.startLine, ...(next.endLine === undefined ? {} : { endLine: next.endLine }), text: next.text }
    options.setAttachments((current) => {
      const previousAttachmentComment = { id: previous.id, startLine: previous.startLine, ...(previous.endLine === undefined ? {} : { endLine: previous.endLine }), text: previous.text }
      let nextAttachments = current
      for (const existing of current) if (lineCommentScopeMatchesAttachment(scope, existing)) nextAttachments = updateLineCommentAttachment(nextAttachments, { attachment, previous: previousAttachmentComment, next: nextAttachmentComment })
      return nextAttachments
    })
  }

  function handleComposerDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    options.setDragActive(true)
  }
  function handleComposerDragOver(event: React.DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    options.setDragActive(true)
  }
  function handleComposerDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) options.setDragActive(false)
  }
  function handleComposerDrop(event: React.DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    options.setDragActive(false)
    void addAttachmentFiles(Array.from(event.dataTransfer.files))
  }
  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return
    event.preventDefault()
    void addAttachmentFiles(files)
  }

  return { addAttachments, addAttachmentFiles, mergeAttachments, removeAttachment, removeLineCommentAttachment, updatePublishedLineCommentAttachment, handleComposerDragEnter, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop, handleComposerPaste }
}
