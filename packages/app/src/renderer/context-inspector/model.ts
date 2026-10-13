import type { ContextInspection, ContextInspectionRequest } from '../../shared/context-inspector-contracts'

export function selectContextRequest(data: ContextInspection | null, sessionId: string | null, modelRef: string | undefined, requestId?: string): ContextInspectionRequest | undefined {
  if (!data || !sessionId || data.sessionId !== sessionId) return undefined
  if (requestId) return data.requests.find((request) => request.requestId === requestId)
  return [...data.requests].reverse().find((request) => request.conversationRequest && request.modelRef === modelRef)
    ?? [...data.requests].reverse().find((request) => request.conversationRequest)
}

export function contextOccupancy(request: ContextInspectionRequest | undefined, modelRef: string | undefined): { tokens?: number; source: 'local' | 'provider' | 'unavailable'; historical: boolean } {
  const historical = !!request && request.modelRef !== modelRef
  if (!request || historical || !request.conversationRequest) return { source: 'unavailable', historical }
  const { local, provider } = request.trace.tokens
  if (local.status === 'exact') return { tokens: local.promptTokens, source: 'local', historical }
  if (provider.status === 'reported') return { tokens: provider.promptTokens, source: 'provider', historical }
  return { source: 'unavailable', historical }
}

export function tokenValue(value: number | undefined): string {
  return value === undefined ? '不可用' : value.toLocaleString('zh-CN')
}

export function snapshotTime(value: string | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间不可用'
}
