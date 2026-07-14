import { describe, expect, it } from 'vitest'
import type { RunAttachment } from '@littlesheep/types'
import { attachmentContextMessages, attachmentManifestText } from './_shared.js'

describe('attachment context helpers', () => {
  const attachment: RunAttachment = {
    id: 'attachment-1',
    path: 'D:/files/notes.md',
    name: 'notes.md',
    kind: 'document',
    size: 128,
    ownership: 'external',
    contentState: 'uninspected',
  }

  it('publishes a manifest id and an explicit on-demand inspection path', () => {
    const manifest = attachmentManifestText([attachment])
    expect(manifest).toContain('[attachment-1] notes.md')
    expect(manifest).toContain('uninspected')
    expect(manifest).toContain('inspect_attachment')
  })

  it('does not inject extracted text outside the tool result path', () => {
    const messages = attachmentContextMessages('run-attachments', [{
      ...attachment,
      extractedText: 'private file body',
      contentState: 'loaded',
    }])
    expect(messages).toHaveLength(1)
    expect(String(messages[0]?.message.content)).not.toContain('private file body')
    expect(messages[0]?.context).toMatchObject({
      id: 'attachment-manifest:run-attachments',
      source: {
        kind: 'attachment',
        id: 'attachment-manifest:run-attachments',
        runId: 'run-attachments',
      },
    })
  })
})
