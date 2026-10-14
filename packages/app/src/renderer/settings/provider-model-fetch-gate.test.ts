import { describe, expect, it } from 'vitest'
import type { RuntimeProvider } from '../../shared/runtime-api-contracts'
import type { ProviderEditorDraft } from './model-provider-draft'
import { modelFetchBlockedReason } from './provider-model-fetch-gate'

const draft = (overrides: Partial<ProviderEditorDraft> = {}): ProviderEditorDraft => ({
  id: 'my-gw',
  name: '',
  baseURL: 'https://gw.example.com/v1',
  api: 'openai-chat-completions',
  apiKey: '',
  models: [],
  originalId: 'my-gw',
  ...overrides,
})

const saved = (overrides: Partial<RuntimeProvider> = {}): RuntimeProvider => ({
  id: 'my-gw',
  name: 'My Gateway',
  baseURL: 'https://gw.example.com/v1',
  api: 'openai-chat-completions',
  models: [],
  headerNames: [],
  envVar: 'MY_GW_API_KEY',
  requiresKey: true,
  hasKey: true,
  builtin: false,
  ...overrides,
})

describe('获取模型 availability', () => {
  it('is available once the address and a key are in the draft', () => {
    expect(modelFetchBlockedReason({ draft: draft({ apiKey: 'sk-typed' }), fetching: false, savedProvider: saved() })).toBeNull()
  })

  it('names the missing fact instead of failing later', () => {
    expect(modelFetchBlockedReason({ draft: draft({ baseURL: '', apiKey: 'sk' }), fetching: false, savedProvider: null }))
      .toContain('API 地址')
    expect(modelFetchBlockedReason({ draft: draft({ baseURL: 'not a url', apiKey: 'sk' }), fetching: false, savedProvider: null }))
      .toContain('http(s)')
    expect(modelFetchBlockedReason({ draft: draft({ apiKey: 'sk' }), fetching: true, savedProvider: null }))
      .toContain('正在获取')
  })

  it('asks for a retyped key only when the keychain really holds one', () => {
    const blocked = modelFetchBlockedReason({ draft: draft(), fetching: false, savedProvider: saved() })
    expect(blocked).toContain('MY_GW_API_KEY')
    expect(blocked).toContain('已保存在密钥库')
  })

  it('does not claim a stored key when the reference is unresolvable', () => {
    const blocked = modelFetchBlockedReason({
      draft: draft(),
      fetching: false,
      savedProvider: saved({ hasKey: false }),
    })
    expect(blocked).not.toContain('已保存在密钥库')
    expect(blocked).toContain('需要密钥')
  })

  it('blocks the literal-key provider whose key the UI cannot reuse', () => {
    // `envVar` is null for a literal key in config, but the endpoint still needs a
    // credential: an enabled button would send an unauthenticated request.
    const blocked = modelFetchBlockedReason({
      draft: draft(),
      fetching: false,
      savedProvider: saved({ envVar: null, hasKey: true }),
    })
    expect(blocked).toContain('需要密钥')
  })

  it('allows a keyless local endpoint and a provider that does not exist yet', () => {
    expect(modelFetchBlockedReason({
      draft: draft(),
      fetching: false,
      savedProvider: saved({ id: 'ollama', envVar: null, requiresKey: false, hasKey: false }),
    })).toBeNull()
    expect(modelFetchBlockedReason({
      draft: draft({ originalId: null }),
      fetching: false,
      savedProvider: null,
    })).toBeNull()
  })
})
