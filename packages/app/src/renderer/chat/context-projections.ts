import type { ContextSnapshot } from '@littlesheep/types'
import type { CompactionOperationRecord } from '../../shared/compaction-operation-contracts'

export type ConversationContextProjectionKind = 'context_injection' | 'cross_session_recall' | 'context_compaction'

export interface ConversationContextProjection {
  kind: ConversationContextProjectionKind
  label: string
  detail: string
}

/** Convert internal context accounting into bounded, content-free conversation facts. */
export function projectConversationContext(snapshots: ContextSnapshot[] | undefined): ConversationContextProjection[] {
  const snapshot = snapshots?.at(-1)
  if (!snapshot) return []
  const included = snapshot.items.filter((item) => item.disposition === 'included')
  const memory = included.filter((item) => item.source.kind === 'memory'
    || item.kind === 'memory_index' || item.kind === 'memory_fragment' || item.kind === 'project_knowledge')
  const crossSession = included.filter((item) => item.kind === 'summary_memory'
    || (item.source.kind === 'memory' && (item.scope === 'session' || item.scope === 'global')))
  const result: ConversationContextProjection[] = []
  if (memory.length > 0) result.push({
    kind: 'context_injection',
    label: '上下文注入',
    detail: `${memory.length} 个记忆项 · ${sumTokens(memory)} tokens`,
  })
  if (crossSession.length > 0) result.push({
    kind: 'cross_session_recall',
    label: '跨会话召回',
    detail: `${crossSession.length} 个历史项`,
  })
  if (included.some((item) => item.kind === 'summary_memory')) result.push({
    kind: 'context_compaction',
    label: '上下文已压缩',
    detail: '使用可追溯会话摘要',
  })
  return result
}

function sumTokens(items: ContextSnapshot['items']): number {
  return items.reduce((total, item) => total + (item.promptTokens ?? 0), 0)
}

/**
 * Project the session's newest durable compaction operation. Only real terminal
 * facts are shown; a running or unknown operation renders nothing.
 */
export function projectCompactionOperations(
  operations: readonly CompactionOperationRecord[] | undefined,
): ConversationContextProjection[] {
  const latest = operations?.at(-1)
  if (!latest) return []
  if (latest.status === 'failed') {
    return [{
      kind: 'context_compaction',
      label: '上下文压缩失败',
      detail: latest.error?.slice(0, 200) || '旧原文已保留，将在下次运行重试',
    }]
  }
  if (latest.status === 'cancelled') {
    return [{ kind: 'context_compaction', label: '上下文压缩已取消', detail: '原始消息仍完整保留' }]
  }
  if (latest.status !== 'completed') return []
  if (latest.result === 'no-new-range') {
    return [{ kind: 'context_compaction', label: '上下文无需压缩', detail: '没有新的可压缩区间' }]
  }
  const requests = latest.usage?.requestCount
  return [{
    kind: 'context_compaction',
    label: '上下文已压缩',
    detail: latest.usage?.totalTokens !== undefined
      ? `本次压缩 ${requests ?? 0} 次请求 · ${latest.usage.totalTokens} tokens`
      : `本次压缩 ${requests ?? 0} 次请求`,
  }]
}
