import { describe, expect, it } from 'vitest'
import type { ContextSnapshot } from '@littlesheep/types'
import type { CompactionOperationRecord } from '../../shared/compaction-operation-contracts'
import { projectCompactionOperations, projectConversationContext } from './context-projections'

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

describe('compaction operation projections', () => {
  const operation = (overrides: Partial<CompactionOperationRecord>): CompactionOperationRecord => ({
    id: 'operation-1',
    sessionId: 'session-1',
    force: false,
    createdAt: '2026-09-16T00:00:00.000Z',
    status: 'completed',
    result: 'compacted',
    coalescedRequests: 0,
    ...overrides,
  })

  it('projects a completed operation with real usage and never invents tokens', () => {
    expect(projectCompactionOperations([operation({
      usage: { requestCount: 2, totalTokens: 512, usageStatus: 'reported' },
    })])).toEqual([{ kind: 'context_compaction', label: '上下文已压缩', detail: '本次压缩 2 次请求 · 512 tokens' }])
    expect(projectCompactionOperations([operation({
      usage: { requestCount: 1, usageStatus: 'unavailable' },
    })])).toEqual([{ kind: 'context_compaction', label: '上下文已压缩', detail: '本次压缩 1 次请求' }])
  })

  it('renders terminal failure, cancellation and no-op outcomes distinctly', () => {
    expect(projectCompactionOperations([operation({ status: 'failed', error: 'provider timed out' })])[0])
      .toMatchObject({ label: '上下文压缩失败', detail: 'provider timed out' })
    expect(projectCompactionOperations([operation({ status: 'cancelled', result: undefined })])[0])
      .toMatchObject({ label: '上下文压缩已取消' })
    expect(projectCompactionOperations([operation({ result: 'no-new-range' })])[0])
      .toMatchObject({ label: '上下文无需压缩' })
  })

  it('renders nothing for a running, unknown or absent operation', () => {
    expect(projectCompactionOperations(undefined)).toEqual([])
    expect(projectCompactionOperations([])).toEqual([])
    expect(projectCompactionOperations([operation({ status: 'running', result: undefined })])).toEqual([])
  })
})
