import { describe, expect, it } from 'vitest'
import type { ContextSnapshot } from '@littlesheep/types'
import { projectConversationContext } from './context-projections'

describe('conversation context projections', () => {
  it('projects memory injection, cross-session recall and compaction without content', () => {
    const snapshot = {
      items: [
        { kind: 'memory_fragment', scope: 'global', source: { kind: 'memory' }, disposition: 'included', promptTokens: 24 },
        { kind: 'summary_memory', scope: 'session', source: { kind: 'memory' }, disposition: 'included', promptTokens: 16 },
        { kind: 'recent_message', scope: 'session', source: { kind: 'message' }, disposition: 'included', promptTokens: 8 },
      ],
    } as ContextSnapshot

    expect(projectConversationContext([snapshot])).toEqual([
      { kind: 'context_injection', label: '上下文注入', detail: '2 个记忆项 · 40 tokens' },
      { kind: 'cross_session_recall', label: '跨会话召回', detail: '2 个历史项' },
      { kind: 'context_compaction', label: '上下文已压缩', detail: '使用可追溯会话摘要' },
    ])
    expect(JSON.stringify(projectConversationContext([snapshot]))).not.toContain('recent_message')
  })
})
