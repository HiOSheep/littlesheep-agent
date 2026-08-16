import type { AttachmentLineComment, AttachmentRef } from '../api'
import { isSamePath } from './path-utils'

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
  return attachments.map((attachment) => isSamePath(attachment.path, incoming.path)
    ? {
      ...attachment,
      ...incoming,
      ...(lineComments.length > 0 ? { lineComments } : {}),
      ...(inlineText ? { inlineText } : {}),
    }
    : attachment)
}

function mergeInlineText(existing: string | undefined, incoming: string | undefined): string | undefined {
  const snapshots = [existing, incoming].filter((value): value is string => Boolean(value?.trim()))
  return [...new Set(snapshots)].join('\n\n').slice(0, 100_000) || undefined
}

function dedupeLineComments(comments: AttachmentLineComment[]): AttachmentLineComment[] {
  return comments.filter((comment, index, all) => (
    all.findIndex((candidate) => (
      candidate.startLine === comment.startLine
      && candidate.endLine === comment.endLine
      && candidate.text === comment.text
    )) === index
  ))
}
