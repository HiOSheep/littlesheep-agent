import { describe, expect, it } from 'vitest'
import { chatContentSignature } from './use-chat-scroll-controller'
import type { ChatMessage } from './types'

describe('new output while reading away', () => {
  it('detects growing timeline prose and tool outcomes without changing on a clock tick', () => {
    const message: ChatMessage = { role: 'assistant', id: 'turn', text: '', activity: {
      status: 'running', instruction: 'task', startedAt: 1, steps: [], tools: [],
      transcript: [{ kind: 'text', id: 'prose', text: '第一段', status: 'running' }],
    } }
    const initial = chatContentSignature([message])
    const grown: ChatMessage = { ...message, activity: { ...message.activity!, transcript: [{ kind: 'text', id: 'prose', text: '第一段继续输出', status: 'running' }] } }
    expect(chatContentSignature([grown])).not.toBe(initial)
    expect(chatContentSignature([{ ...grown, activity: { ...grown.activity!, durationMs: 500 } }])).toBe(chatContentSignature([grown]))
    const finished: ChatMessage = { ...grown, activity: { ...grown.activity!, tools: [{ callId: 'read', name: 'read', ok: true, output: 'file content' }] } }
    expect(chatContentSignature([finished])).not.toBe(chatContentSignature([grown]))
  })
})
