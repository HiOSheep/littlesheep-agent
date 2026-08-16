import { describe, expect, it } from 'vitest'
import { asSessionId } from '@littlesheep/types'
import { conversationTurnInputDigest } from './conversation-turn'

describe('conversation turn input digest', () => {
  it('treats different source line comments as different run inputs', () => {
    const base = {
      sessionId: asSessionId('session-line-comments'),
      requestKey: 'request-line-comments',
      text: 'Review this context.',
      attachments: [{
        id: 'attachment-1',
        path: 'D:/cache/source.ts',
        contextPath: 'src/source.ts',
        kind: 'file' as const,
        contentHash: 'a'.repeat(64),
        lineComments: [{ startLine: 12, text: 'Check this branch.' }],
      }],
    }
    const changed = structuredClone(base)
    changed.attachments[0]!.lineComments[0]!.startLine = 13

    expect(conversationTurnInputDigest(base)).not.toBe(conversationTurnInputDigest(changed))
  })
})
