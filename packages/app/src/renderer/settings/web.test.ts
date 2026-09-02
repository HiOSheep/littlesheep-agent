import { describe, expect, it } from 'vitest'
import { statusLabel } from './web-state'
import type { RuntimeWebState } from '../../shared/runtime-api-contracts'

function state(status: RuntimeWebState['status']): RuntimeWebState {
  return {
    enabled: status !== 'disabled', status, providerId: 'tavily', providerConfigured: status !== 'unconfigured',
    readMode: 'public_anonymous', dnsResolver: 'system', strictReadApproval: false, allowDomains: [], blockDomains: [],
    cacheEnabled: true, cacheTtlSeconds: 300, cacheMaxBytes: 1024,
    browserFallback: 'approval_required', sensitiveQueryPolicy: 'approve',
    egress: ['query_to_search_provider', 'url_to_target_site', 'evidence_to_current_llm_provider'],
  }
}

describe('Web settings status copy', () => {
  it('distinguishes disabled, unconfigured, unchecked, degraded and ready states', () => {
    expect(statusLabel(state('disabled'))).toBe('已关闭')
    expect(statusLabel(state('unconfigured'))).toBe('搜索服务未配置')
    expect(statusLabel(state('configured_unchecked'))).toContain('尚未检查')
    expect(statusLabel(state('degraded'))).toBe('部分可用')
    expect(statusLabel(state('ready'))).toContain('可用')
  })
})
