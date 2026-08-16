import type { AttachmentRef } from '../shared/attachment-contracts.js'
import type { ManagedAttachmentCache } from './attachment-cache.js'

export async function ensureManagedAttachmentRefs(
  attachments: AttachmentRef[],
  cache: ManagedAttachmentCache,
): Promise<AttachmentRef[]> {
  return Promise.all(attachments.map(async (attachment) => {
    if (attachment.cacheId) return attachment
    const managed = attachment.inlineText
      ? await cache.importData({
        dataUrl: `data:text/plain,${encodeURIComponent(attachment.inlineText)}`,
        name: attachment.name,
      })
      : await cache.importFile(attachment)
    return {
      ...managed,
      contextPath: attachment.contextPath,
      lineComments: attachment.lineComments,
    }
  }))
}
