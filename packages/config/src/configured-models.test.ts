import { afterEach, describe, expect, it } from 'vitest'
import { ConfigSchema } from './schema.js'
import {
  clearConfiguredModelCapabilities,
  registerConfiguredModelCapabilities,
} from './configured-models.js'
import {
  getSupportedReasoningOptions,
  resolveModelContextWindow,
  resolveModelTokenizerCapability,
  resolveProviderReasoningRequest,
} from './model-capabilities.js'
import { resolveProviderModels, resolveProviderModelIds } from './provider-models.js'

afterEach(() => {
  clearConfiguredModelCapabilities()
})

describe('user-declared provider models', () => {
  it('normalizes bare ids and declared entries without inventing metadata', () => {
    const provider = ConfigSchema.parse({
      providers: [{
        id: 'my-gw',
        baseURL: 'https://gw.example.com/v1',
        models: [
          'plain-model',
          {
            id: 'vendor-model',
            name: 'Vendor Model',
            contextWindow: 256000,
            maxOutputTokens: 32000,
            reasoningOptions: ['auto', 'high'],
          },
        ],
      }],
    }).providers[0]!

    const models = resolveProviderModels(provider)
    expect(models).toEqual([
      { id: 'plain-model', name: 'plain-model', declared: false },
      {
        id: 'vendor-model',
        name: 'Vendor Model',
        declared: true,
        contextWindow: 256000,
        maxOutputTokens: 32000,
        reasoningOptions: ['auto', 'high'],
      },
    ])
    expect(resolveProviderModelIds(provider)).toEqual(['plain-model', 'vendor-model'])
  })

  it('serves declared metadata only for models the built-in registry does not know', () => {
    const config = ConfigSchema.parse({
      providers: [{
        id: 'my-gw',
        baseURL: 'https://gw.example.com/v1',
        models: [
          { id: 'vendor-model', contextWindow: 256000, maxOutputTokens: 32000, reasoningOptions: ['auto', 'high', 'ultra'], ultraEffort: 'xhigh' },
          'plain-model',
        ],
      }],
    })
    registerConfiguredModelCapabilities(config)

    expect(resolveModelContextWindow('my-gw', 'vendor-model')).toMatchObject({
      maxContextTokens: 256000,
      maxOutputTokens: 32000,
      source: 'user-config',
    })
    expect(getSupportedReasoningOptions('my-gw', 'vendor-model')).toEqual(['auto', 'high', 'ultra'])
    expect(resolveProviderReasoningRequest('my-gw', 'vendor-model', 'ultra')).toEqual({
      reasoningEffort: 'xhigh',
    })
    // "auto" never sends a provider effort, even for a declared model.
    expect(resolveProviderReasoningRequest('my-gw', 'vendor-model', 'auto')).toEqual({})
    expect(resolveProviderReasoningRequest('my-gw', 'vendor-model', 'low')).toEqual({})

    // Undeclared models stay unknown instead of inheriting a guessed window.
    expect(resolveModelContextWindow('my-gw', 'plain-model')).toBeUndefined()
    expect(getSupportedReasoningOptions('my-gw', 'plain-model')).toEqual(['auto'])
    expect(resolveModelTokenizerCapability('my-gw', 'plain-model')).toBeUndefined()
  })

  it('reports an unavailable tokenizer for declared models and never claims exactness', () => {
    const config = ConfigSchema.parse({
      providers: [{
        id: 'my-gw',
        baseURL: 'https://gw.example.com/v1',
        models: [{ id: 'vendor-model', contextWindow: 128000 }],
      }],
    })
    registerConfiguredModelCapabilities(config)

    const capability = resolveModelTokenizerCapability('my-gw', 'vendor-model')
    expect(capability).toMatchObject({
      status: 'unavailable',
      reasonCode: 'no-verified-final-request-counter',
      source: 'user-config',
    })
    expect(capability && capability.status === 'unavailable' ? capability.reason : '').toContain('my-gw/vendor-model')
  })

  it('never lets a user declaration overwrite a built-in provider fact', () => {
    const config = ConfigSchema.parse({
      providers: [{
        id: 'deepseek',
        baseURL: 'https://api.deepseek.com',
        models: [{ id: 'deepseek-flash', contextWindow: 4096 }],
      }],
    })
    registerConfiguredModelCapabilities(config)

    expect(resolveModelContextWindow('deepseek', 'deepseek-flash')).toMatchObject({
      maxContextTokens: 1_000_000,
      source: 'official-provider-doc',
    })
  })
})

describe('provider schema guards', () => {
  it('rejects an unknown wire protocol instead of sending it as compatible', () => {
    const parsed = ConfigSchema.safeParse({
      providers: [{ id: 'gw', baseURL: 'https://gw.example.com/v1', api: 'anthropic-messages' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects provider ids that cannot become a stable keychain reference', () => {
    const parsed = ConfigSchema.safeParse({
      providers: [{ id: '', baseURL: 'https://gw.example.com/v1' }],
    })
    expect(parsed.success).toBe(false)
  })
})
