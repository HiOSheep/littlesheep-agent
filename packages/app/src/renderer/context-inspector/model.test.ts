import { describe, expect, it } from 'vitest'
import { ContextEngine, buildContextTrace } from '@littlesheep/context'
import { asSessionId } from '@littlesheep/types'
import { contextOccupancy, loadedContextUsage, selectContextRequest, tokenValue } from './model'

function data() {
  const prepared = new ContextEngine().prepare({ runId: 'run', sessionId: asSessionId('session'), stage: 'execute', requestIndex: 1,
    request: { model: 'test/model', messages: [{ role: 'user', content: 'hello' }] } })
  const requests = [{ runId: 'run', requestId: 'request', requestIndex: 1, modelRef: 'test/model',
    runState: 'recorded' as const, conversationRequest: true, trace: buildContextTrace(prepared.contextSnapshot, prepared.modelRequestSnapshot)! }]
  return { version: 1 as const, sessionId: 'session', coverage: 'loaded_history' as const, requests, retainedRequests: 1, truncated: false, active: false }
}

describe('Inspector request adaptation', () => {
  it('aggregates only unique loaded Provider reports and marks missing fields partial', () => {
    const inspection = data()
    inspection.requests[0]!.trace.tokens.provider = { status: 'reported', promptTokens: 10, completionTokens: 2, cachedPromptTokens: 0 }
    inspection.requests[0]!.trace.tokens.local = { status: 'exact', promptTokens: 999 }
    inspection.requests.push({ ...inspection.requests[0]! })
    expect(loadedContextUsage(inspection)).toMatchObject({ requests: 1, input: { value: 10, partial: false }, cached: { value: 0, partial: false }, written: { value: undefined, partial: true } })
    inspection.requests.push({ ...inspection.requests[0]!, requestId: 'missing', trace: { ...inspection.requests[0]!.trace, tokens: { local: { status: 'unavailable' }, provider: { status: 'unavailable' } } } })
    expect(loadedContextUsage(inspection).input).toEqual({ value: 10, partial: true })
    expect(loadedContextUsage(null).input.value).toBeUndefined()
  })
  it('refuses stale sessions, missing traces and unknown counts without manufacturing zero', () => {
    const inspection = data()
    expect(selectContextRequest(inspection, 'different', 'test/model')).toBeUndefined()
    expect(selectContextRequest(null, null, 'test/model')).toBeUndefined()
    expect(contextOccupancy(inspection.requests[0], 'test/model').tokens).toBeUndefined()
    expect(tokenValue(undefined)).toBe('不可用')
    expect(tokenValue(0)).toBe('0')
  })
  it('keeps local and provider ledgers separate and uses ring precedence only for occupancy', () => {
    const request = data().requests[0]!
    request.trace.tokens.local = { status: 'exact', promptTokens: 5000 }
    request.trace.tokens.provider = { status: 'reported', promptTokens: 5100, completionTokens: 100 }
    expect(contextOccupancy(request, request.modelRef)).toMatchObject({ tokens: 5000, source: 'local' })
    expect(request.trace.tokens.provider.promptTokens).toBe(5100)
    expect(contextOccupancy(request, 'another/model')).toMatchObject({ source: 'unavailable', historical: true })
    request.trace.tokens.local = { status: 'unavailable' }
    expect(contextOccupancy(request, request.modelRef)).toMatchObject({ tokens: 5100, source: 'provider' })
  })
  it('binds an explicit historical snapshot without treating it as the current request', () => {
    const inspection = data()
    inspection.requests.push({ ...inspection.requests[0]!, requestId: 'compaction', conversationRequest: false })
    expect(selectContextRequest(inspection, 'session', 'test/model')?.conversationRequest).toBe(true)
    const historical = selectContextRequest(inspection, 'session', 'test/model', 'compaction')
    expect(historical?.requestId).toBe('compaction')
    expect(contextOccupancy(historical, 'test/model').source).toBe('unavailable')
  })
});
