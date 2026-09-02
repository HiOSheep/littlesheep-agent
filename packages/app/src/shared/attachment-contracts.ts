// Stable attachment metadata shared by import, run and renderer boundaries.

import type { AttachmentOwnership } from '@littlesheep/types'

export interface AttachmentLineComment {
  /** Renderer-side identity used to update or remove one published comment. */
  id?: string
  startLine: number
  endLine?: number
  text: string
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
