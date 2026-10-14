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

/** Totals cover only unique loaded requests. Missing fields never become zero. */
export function loadedContextUsage(data: ContextInspection | null) {
  const requests = [...new Map(data?.requests.map((item) => [`${item.runId}:${item.requestId}`, item])).values()];
  const sum = (field: 'promptTokens' | 'completionTokens' | 'cachedPromptTokens' | 'cacheWriteTokens') => {
    const values = requests.map((item) => item.trace.tokens.provider.status === 'reported' ? item.trace.tokens.provider[field] : undefined);
    const available = values.filter((value): value is number => value !== undefined);
    return { value: available.length ? available.reduce((total, value) => total + value, 0) : undefined,
      partial: available.length !== requests.length };
  };
  return { requests: requests.length, input: sum('promptTokens'), output: sum('completionTokens'),
    cached: sum('cachedPromptTokens'), written: sum('cacheWriteTokens') };
}
