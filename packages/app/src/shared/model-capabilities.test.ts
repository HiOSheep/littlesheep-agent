import { describe, expect, it } from 'vitest'
import {
  coerceReasoningForModelRef,
  getContextWindowForModelRef,
  getSupportedReasoningOptions,
  getSupportedReasoningOptionsForModelRef,
  resolveProviderReasoningRequest,
  resolveModelContextWindowForModelRef,
  resolveModelTokenizerCapabilityForModelRef,
} from './model-capabilities'

describe('model reasoning capabilities', () => {
  it('keeps extended effort controls for current GPT-5.6 family models', () => {
    expect(getSupportedReasoningOptionsForModelRef('openai/gpt-5.6')).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'ultra',
    ])
  })

  it('does not expose an unsupported low effort for GPT-5.5 Pro', () => {
    expect(getSupportedReasoningOptionsForModelRef('openai/gpt-5.5-pro')).toEqual([
      'auto',
      'medium',
      'high',
      'ultra',
    ])
  })

  it('hides reasoning effort controls for non-reasoning OpenAI chat models', () => {
    expect(getSupportedReasoningOptionsForModelRef('openai/gpt-4.1')).toEqual(['auto'])
  })

  it('only exposes high and max-style controls for DeepSeek V4 reasoning models', () => {
    expect(getSupportedReasoningOptions('deepseek', 'deepseek-v4-flash')).toEqual(['auto', 'high', 'ultra'])
    expect(coerceReasoningForModelRef('medium', 'deepseek/deepseek-v4-flash')).toBe('auto')
  })

  it('only exposes distinct effort controls for GLM 5.2', () => {
    expect(getSupportedReasoningOptionsForModelRef('glm/glm-5.2')).toEqual(['auto', 'high', 'ultra'])
    expect(getSupportedReasoningOptionsForModelRef('glm/glm-5.1')).toEqual(['auto'])
  })

  it('maps generic UI effort to each provider official request contract', () => {
    expect(resolveProviderReasoningRequest('deepseek', 'deepseek-v4-flash', 'auto')).toEqual({
      thinking: { type: 'disabled' },
    })
    expect(resolveProviderReasoningRequest('openai', 'gpt-5.6', 'ultra')).toEqual({
      reasoningEffort: 'max',
      thinking: undefined,
    })
    expect(resolveProviderReasoningRequest('openai', 'gpt-5.5', 'ultra')).toEqual({
      reasoningEffort: 'xhigh',
      thinking: undefined,
    })
    expect(resolveProviderReasoningRequest('deepseek', 'deepseek-v4-pro', 'high')).toEqual({
      reasoningEffort: 'high',
      thinking: { type: 'enabled' },
    })
    expect(resolveProviderReasoningRequest('glm', 'glm-5.2', 'ultra')).toEqual({
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    })
  })

  it('maps configured provider models to model-specific context windows', () => {
    expect(getContextWindowForModelRef('openai/gpt-5.6')).toBe(1_050_000)
    expect(getContextWindowForModelRef('openai/gpt-5.5')).toBe(1_050_000)
    expect(getContextWindowForModelRef('openai/gpt-5.4')).toBe(1_050_000)
    expect(getContextWindowForModelRef('openai/gpt-5.2')).toBe(400_000)
    expect(getContextWindowForModelRef('openai/gpt-4.1')).toBe(1_047_576)
    expect(getContextWindowForModelRef('deepseek/deepseek-v4-pro')).toBe(1_000_000)
    expect(getContextWindowForModelRef('glm/glm-5.2')).toBe(1_000_000)
  })

  it('keeps unknown context windows unavailable instead of inventing 128k', () => {
    expect(getContextWindowForModelRef('custom/private-model')).toBe(0)
    expect(resolveModelContextWindowForModelRef('custom/private-model')).toBeUndefined()
  })

  it('retains official source metadata for verified capabilities', () => {
    expect(resolveModelContextWindowForModelRef('glm/glm-5.2')).toMatchObject({
      maxContextTokens: 1_000_000,
      maxOutputTokens: 131_072,
      source: 'official-provider-doc',
      verifiedAt: '2026-07-13',
    })
  })

  it('classifies built-in tokenizer support without inventing exact local counts', () => {
    expect(resolveModelTokenizerCapabilityForModelRef('openai/gpt-5.6')).toMatchObject({
      status: 'unavailable',
      reasonCode: 'no-verified-final-request-counter',
      source: 'builtin-model-registry',
      verifiedAt: '2026-07-13',
    })
    // 2026-09-11: V4.1 has its own pinned tokenizer and framing, calibrated
    // against real Provider usage (five request shapes, zero delta).
    expect(resolveModelTokenizerCapabilityForModelRef('deepseek/deepseek-v4-flash')).toMatchObject({
      status: 'exact',
      counterId: 'deepseek-v41-provider-calibrated-tokenizer-v1',
    })
    expect(resolveModelTokenizerCapabilityForModelRef('deepseek/deepseek-flash')).toMatchObject({
      status: 'exact',
      counterId: 'deepseek-v41-provider-calibrated-tokenizer-v1',
    })
    expect(resolveModelContextWindowForModelRef('deepseek/deepseek-flash')).toMatchObject({
      maxContextTokens: 1_000_000,
      maxOutputTokens: 384_000,
      source: 'official-provider-doc',
    })
    expect(getSupportedReasoningOptions('deepseek', 'deepseek-flash')).toEqual(['auto', 'high', 'ultra'])
    expect(resolveModelTokenizerCapabilityForModelRef('glm/glm-5.1')).toMatchObject({
      status: 'unavailable',
      reasonCode: 'no-verified-final-request-counter',
    })
  })

  it('keeps custom tokenizer capability unclassified until explicitly verified', () => {
    expect(resolveModelTokenizerCapabilityForModelRef('custom/private-model')).toBeUndefined()
  })
})
