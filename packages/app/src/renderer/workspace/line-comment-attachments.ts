import type { AttachmentLineComment, AttachmentRef } from '../api'
import { isSamePath } from './path-utils'

export interface LineCommentAttachmentRemoval {
  id: number
  attachment: AttachmentRef
}

export interface LineCommentAttachmentChange {
  attachment: AttachmentRef
  previous: AttachmentLineComment
  next: AttachmentLineComment | null
}

export function mergeLineCommentAttachment(
  attachments: AttachmentRef[],
  incoming: AttachmentRef,
): AttachmentRef[] {
  const existing = attachments.find((attachment) => isSamePath(attachment.path, incoming.path))
  if (!existing) return [...attachments, incoming]

  const lineComments = dedupeLineComments([
    ...(existing.lineComments ?? []),
    ...(incoming.lineComments ?? []),
  ])
  const inlineText = mergeInlineText(existing.inlineText, incoming.inlineText)
  const lineCommentOnly = existing.lineCommentOnly === true && (existing.lineComments?.length ?? 0) > 0
    ? true
    : existing.lineComments && existing.lineComments.length > 0
      ? false
      : existing.lineCommentOnly ?? false
  return attachments.map((attachment) => isSamePath(attachment.path, incoming.path)
    ? {
      ...attachment,
      ...incoming,
      lineCommentOnly,
      ...(lineComments.length > 0 ? { lineComments } : {}),
      ...(lineComments.length === 0 ? { lineComments: undefined } : {}),
      ...(inlineText ? { inlineText } : {}),
    }
    : attachment)
}

export function updateLineCommentAttachment(
  attachments: AttachmentRef[],
  change: LineCommentAttachmentChange,
): AttachmentRef[] {
  const existing = attachments.find((attachment) => isSamePath(attachment.path, change.attachment.path))
  if (!existing) return attachments

  const comments = [...(existing.lineComments ?? [])]
  const index = findLineCommentIndex(comments, change.previous, change.next)
  if (index < 0) return attachments

  if (change.next === null) comments.splice(index, 1)
  else comments[index] = { ...comments[index]!, ...change.next }

  if (comments.length === 0 && existing.lineCommentOnly) {
    return attachments.filter((attachment) => attachment !== existing)
  }

  return attachments.map((attachment) => attachment === existing
    ? {
      ...existing,
      ...change.attachment,
      ...(comments.length > 0 ? { lineComments: comments } : { lineComments: undefined }),
    }
    : attachment)
}

export function lineCommentScopeMatchesAttachment(
  scope: string,
  attachment: AttachmentRef,
): boolean {
  const parts = scope.split('\u0000')
  const scopeKind = parts[1]
  const scopePath = parts[2]
  if ((scopeKind !== 'file' && scopeKind !== 'review') || !scopePath) return false

  return [attachment.path, attachment.contextPath]
    .filter((path): path is string => Boolean(path))
    .some((path) => isSamePath(path, scopePath))
}

function mergeInlineText(existing: string | undefined, incoming: string | undefined): string | undefined {
  const snapshots = [existing, incoming].filter((value): value is string => Boolean(value?.trim()))
  return [...new Set(snapshots)].join('\n\n').slice(0, 100_000) || undefined
}

function dedupeLineComments(comments: AttachmentLineComment[]): AttachmentLineComment[] {
  const result: AttachmentLineComment[] = []
  for (const comment of comments) {
    const identityIndex = comment.id
      ? result.findIndex((candidate) => candidate.id === comment.id)
      : -1
    if (identityIndex >= 0) {
      result[identityIndex] = { ...result[identityIndex]!, ...comment }
      continue
    }
    const duplicateIndex = result.findIndex((candidate) => (
      candidate.startLine === comment.startLine
      && candidate.endLine === comment.endLine
      && candidate.text === comment.text
    ))
    if (duplicateIndex >= 0) continue
    result.push(comment)
  }
  return result
}

function findLineCommentIndex(
  comments: AttachmentLineComment[],
  previous: AttachmentLineComment,
  next: AttachmentLineComment | null,
): number {
  if (previous.id) {
    const byId = comments.findIndex((comment) => comment.id === previous.id)
    if (byId >= 0) return byId
  }
  if (next?.id) {
    const byNextId = comments.findIndex((comment) => comment.id === next.id)
    if (byNextId >= 0) return byNextId
  }
  return comments.findIndex((comment) => (
    comment.startLine === previous.startLine
    && comment.endLine === previous.endLine
    && (comment.text === previous.text || comment.text.startsWith(`${previous.text}\n\n`))
  ))
}
