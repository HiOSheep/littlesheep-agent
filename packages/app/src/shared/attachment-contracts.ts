// Stable attachment metadata shared by import, run and renderer boundaries.

import type { AttachmentOwnership } from '@littlesheep/types'

export interface AttachmentLineComment {
  /** Renderer-side identity used to update or remove one published comment. */
  id?: string
  startLine: number
  endLine?: number
  text: string
  /**
   * The exact source lines the comment was written on, joined with newlines.
   *
   * After a refresh the code under a line number can be something else entirely; keeping
   * what was commented on is what makes that visible instead of silently re-pointing the
   * comment at unrelated code (UX-28 item 4). Absent on comments created before this.
   */
  anchorText?: string
}

export interface AttachmentRef {
  path: string
  /** Source path shown to the Agent when the payload itself lives in managed cache. */
  contextPath?: string
  name?: string
  kind?: 'image' | 'document' | 'file'
  mimeType?: string
  size?: number
  cacheId?: string
  contentHash?: string
  ownership?: AttachmentOwnership
  lineComments?: AttachmentLineComment[]
  /** Renderer-only marker for an attachment created solely by line comments. */
  lineCommentOnly?: boolean
  /** Ephemeral text snapshot converted to managed cache before a run starts. */
  inlineText?: string
}
