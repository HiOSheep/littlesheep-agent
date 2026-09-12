import { describe, expect, it } from 'vitest'
import type { RuntimeProvider } from '../../shared/runtime-api-contracts'
import {
  PROVIDER_TEMPLATES,
  createEmptyProviderDraft,
  createProviderDraftFromTemplate,
  draftFromRuntimeProvider,
  formatTokenCount,
  isConfiguredProvider,
  toggleReasoningOption,
  toProviderDraft,
  validateProviderDraft,
} from './model-provider-draft'

const provider: RuntimeProvider = {
  id: 'my-gw',
  name: 'My Gateway',
  baseURL: 'https://gw.example.com/v1',
  api: 'openai-chat-completions',
  headerNames: [],
  envVar: 'MY_GW_API_KEY',
  requiresKey: true,
  hasKey: true,
  builtin: false,
  models: [
    {
      id: 'vendor-model',
      name: 'Vendor Model',
      declared: true,
      contextWindow: 256000,
      maxOutputTokens: 32000,
      reasoningOptions: ['auto', 'high'],
    },
    {
      id: 'plain-model',
      name: 'plain-model',
      declared: false,
      reasoningOptions: ['auto'],
    },
  ],
}

describe('provider editor draft', () => {
  it('edits an existing provider without inventing a key or dropping metadata', () => {
    const draft = draftFromRuntimeProvider(provider)
    expect(draft.originalId).toBe('my-gw')
    expect(draft.apiKey).toBe('')
    expect(draft.models).toEqual([
      {
        id: 'vendor-model',
        name: 'Vendor Model',
        contextWindow: '256000',
        maxOutputTokens: '32000',
        reasoningOptions: ['auto', 'high'],
      },
      {
        id: 'plain-model',
        name: '',
        contextWindow: '',
        maxOutputTokens: '',
        reasoningOptions: ['auto'],
      },
    ])
    // A bare id keeps its name implicit: no display name is sent for it.
    expect(toProviderDraft(draft).models).toEqual([
      {
        id: 'vendor-model',
        name: 'Vendor Model',
        contextWindow: 256000,
        maxOutputTokens: 32000,
        reasoningOptions: ['auto', 'high'],
      },
      { id: 'plain-model' },
    ])
  })

  it('rejects invalid ids, endpoints, numbers and duplicate model ids', () => {
    const draft = createEmptyProviderDraft()
    expect(validateProviderDraft(draft, []).error).toContain('供应商 ID')

    const blankModel = { ...draft, id: 'my-gw', baseURL: 'https://gw.example.com/v1' }
    expect(validateProviderDraft(blankModel, []).error).toBeNull()

    const upperCase = { ...blankModel, id: 'My-GW' }
    expect(validateProviderDraft(upperCase, []).error).toContain('小写字母')

    const duplicate = {
      ...blankModel,
      models: [
        { id: 'a', name: '', contextWindow: '', maxOutputTokens: '', reasoningOptions: [] },
        { id: 'A', name: '', contextWindow: '', maxOutputTokens: '', reasoningOptions: [] },
      ],
    }
    expect(validateProviderDraft(duplicate, []).error).toContain('重复')

    const badNumber = {
      ...blankModel,
      models: [{ id: 'a', name: '', contextWindow: '-1', maxOutputTokens: '', reasoningOptions: [] }],
    }
    expect(validateProviderDraft(badNumber, []).error).toContain('正整数')

    const badUrl = { ...blankModel, baseURL: 'ftp://gw.example.com' }
    expect(validateProviderDraft(badUrl, []).error).toContain('http(s)')
  })

  it('refuses to reuse an existing provider id when creating a new provider', () => {
    const draft = { ...createEmptyProviderDraft(), id: 'openai', baseURL: 'https://api.openai.com/v1' }
    expect(validateProviderDraft(draft, ['openai', 'deepseek']).error).toContain('已存在')
    const editing = { ...draft, originalId: 'openai' }
    expect(validateProviderDraft(editing, ['openai', 'deepseek']).error).toBeNull()
  })

  it('omits empty numbers so the request never declares a zero window', () => {
    const draft = {
      ...createEmptyProviderDraft(),
      id: 'my-gw',
      baseURL: 'https://gw.example.com/v1',
      apiKey: ' sk-live ',
      models: [{
        id: 'vendor-model',
        name: '',
        contextWindow: '',
        maxOutputTokens: '0',
        reasoningOptions: [],
      }],
    }
    expect(validateProviderDraft(draft, []).error).toContain('正整数')
    const body = toProviderDraft({ ...draft, models: [{ ...draft.models[0]!, maxOutputTokens: '' }] })
    expect(body).toEqual({
      id: 'my-gw',
      baseURL: 'https://gw.example.com/v1',
      apiKey: 'sk-live',
      models: [{ id: 'vendor-model' }],
    })
  })

  it('prefills templates without inventing model ids', () => {
    const template = PROVIDER_TEMPLATES.find((item) => item.id === 'openrouter')!
    const draft = createProviderDraftFromTemplate(template)
    expect(draft.baseURL).toBe('https://openrouter.ai/api/v1')
    expect(draft.models.map((model) => model.id)).toEqual([''])
    expect(draft.originalId).toBeNull()
    expect(validateProviderDraft(draft, []).error).toBeNull()
  })

  it('keeps reasoning toggles in runtime order and formats token counts', () => {
    expect(toggleReasoningOption(['auto', 'high'], 'medium')).toEqual(['auto', 'medium', 'high'])
    expect(toggleReasoningOption(['auto', 'high'], 'auto')).toEqual(['high'])
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(256_000)).toBe('256K')
    expect(formatTokenCount(undefined)).toBe('未声明')
  })

  it('lists only providers the user actually configured', () => {
    const presetWithoutKey = { ...provider, id: 'openai', builtin: true, hasKey: false, requiresKey: true }
    const presetWithKey = { ...provider, id: 'deepseek', builtin: true, hasKey: true, requiresKey: true }
    const keylessLocal = { ...provider, id: 'ollama', builtin: false, hasKey: false, requiresKey: false }
    const customPendingKey = { ...provider, id: 'my-gw', builtin: false, hasKey: false, requiresKey: true }

    expect(isConfiguredProvider(presetWithoutKey)).toBe(false)
    expect(isConfiguredProvider(presetWithKey)).toBe(true)
    expect(isConfiguredProvider(keylessLocal)).toBe(true)
    expect(isConfiguredProvider(customPendingKey)).toBe(true)
  })
})
