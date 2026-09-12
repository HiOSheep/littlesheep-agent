import type { ContextSnapshot } from '@littlesheep/types'

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
