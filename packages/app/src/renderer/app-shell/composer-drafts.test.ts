import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../api'
import {
  NEW_CONVERSATION_DRAFT_KEY,
  conversationDraftKey,
  createComposerDraftSession,
} from './composer-drafts'

function attachment(path: string): AttachmentRef {
  return { path, name: path.split(/[\\/]/u).pop() ?? path, kind: 'file', size: 12 }
}

function createSession(initialSessionId: string | null = null, initialDraft = '') {
  return createComposerDraftSession(initialSessionId, { text: initialDraft, attachments: [] })
}

describe('composer drafts are kept per conversation', () => {
  it('keys a draft by its session id, and by the new-conversation slot before there is one', () => {
    expect(conversationDraftKey('session-a')).toBe('session-a')
    expect(conversationDraftKey(undefined)).toBe(NEW_CONVERSATION_DRAFT_KEY)
    expect(conversationDraftKey(null)).toBe(NEW_CONVERSATION_DRAFT_KEY)
  })

  it('does not show one conversation the draft typed in another', () => {
    const drafts = createSession('session-a')

    drafts.activate('session-b')

    expect(drafts.read()).toEqual({ text: '', attachments: [] })
  })

  it('restores the text and the attachment chips of the conversation switched back to', () => {
    const drafts = createSession('session-a')
    const chips = [attachment('D:\\work-a\\notes.md'), attachment('D:\\work-a\\plan.md')]
    drafts.write({ text: '只属于 A 的草稿', attachments: chips })

    drafts.activate('session-b')
    expect(drafts.read()).toEqual({ text: '', attachments: [] })

    drafts.activate('session-a')
    expect(drafts.read()).toEqual({ text: '只属于 A 的草稿', attachments: chips })
  })

  it('keeps the new conversation separate from a real one in both directions', () => {
    const drafts = createSession()
    drafts.write({ text: '新对话的草稿', attachments: [attachment('D:\\work\\draft.txt')] })

    drafts.activate('session-a')
    expect(drafts.read()).toEqual({ text: '', attachments: [] })

    drafts.activate(undefined)
    expect(drafts.read()).toEqual({
      text: '新对话的草稿',
      attachments: [attachment('D:\\work\\draft.txt')],
    })
  })

  it('seeds the restored session with the recovered draft instead of the new-conversation slot', () => {
    const drafts = createComposerDraftSession('session-a', { text: '重启前的草稿', attachments: [] })

    drafts.activate('session-b')
    expect(drafts.read().text).toBe('')
    drafts.activate('session-a')
    expect(drafts.read().text).toBe('重启前的草稿')
  })

  it('clears only the draft of the conversation the message was sent in', () => {
    const drafts = createSession('session-a')
    drafts.write({ text: 'A 的草稿' })
    drafts.activate('session-b')
    drafts.write({ text: 'B 的草稿', attachments: [attachment('D:\\work-b\\file.md')] })

    // `run-actions` clears through the composer's setters, which land in the active slot.
    drafts.write({ text: '', attachments: [] })

    expect(drafts.read()).toEqual({ text: '', attachments: [] })
    drafts.activate('session-a')
    expect(drafts.read()).toEqual({ text: 'A 的草稿', attachments: [] })
    drafts.activate('session-b')
    expect(drafts.read()).toEqual({ text: '', attachments: [] })
  })

  it('writes text and attachments independently', () => {
    const drafts = createSession('session-a')
    drafts.write({ attachments: [attachment('D:\\work\\a.md')] })
    drafts.write({ text: '先加附件再写字' })

    expect(drafts.read()).toEqual({
      text: '先加附件再写字',
      attachments: [attachment('D:\\work\\a.md')],
    })
    drafts.write({ attachments: [] })
    expect(drafts.read()).toEqual({ text: '先加附件再写字', attachments: [] })
  })

  it('moves the held draft when the run turns the new conversation into a session', () => {
    const drafts = createSession()
    drafts.write({ text: '运行中补写的第二段' })

    drafts.adopt('session-new')

    expect(drafts.key).toBe('session-new')
    expect(drafts.read().text).toBe('运行中补写的第二段')
    // The slot it left is empty again: the draft belongs to the session, not to both.
    drafts.activate(undefined)
    expect(drafts.read()).toEqual({ text: '', attachments: [] })
  })

  it('moves the held draft out of a conversation that went away', () => {
    const drafts = createSession('session-a')
    drafts.write({ text: '这段字不该因为归档而消失' })

    drafts.adopt(undefined)

    expect(drafts.read().text).toBe('这段字不该因为归档而消失')
  })

  it('lets the destination conversation keep its own draft when a session is adopted', () => {
    const drafts = createSession('session-a')
    drafts.activate(undefined)
    drafts.write({ text: '新对话里已有的草稿' })
    drafts.activate('session-a')
    drafts.write({ text: 'A 的草稿' })

    drafts.adopt(undefined)

    expect(drafts.read().text).toBe('新对话里已有的草稿')
  })

  it('hands out copies so a restored draft cannot be edited behind the store', () => {
    const drafts = createSession('session-a')
    drafts.write({ text: '原文', attachments: [attachment('D:\\work\\a.md')] })

    const handed = drafts.read()
    handed.text = '被改过'
    handed.attachments.push(attachment('D:\\work\\b.md'))

    expect(drafts.read()).toEqual({ text: '原文', attachments: [attachment('D:\\work\\a.md')] })
  })
})
