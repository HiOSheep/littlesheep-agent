// Stable attachment metadata shared by import, run and renderer boundaries.

import type { AttachmentOwnership } from '@littlesheep/types'

export interface AttachmentRef {
  path: string
  name?: string
  kind?: 'image' | 'document' | 'file'
  mimeType?: string
  size?: number
  cacheId?: string
  contentHash?: string
  ownership?: AttachmentOwnership
}
