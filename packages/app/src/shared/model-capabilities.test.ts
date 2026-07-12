import { describe, expect, it } from 'vitest'
import {
  coerceReasoningForModelRef,
  getContextWindowForModelRef,
  getSupportedReasoningOptions,
  getSupportedReasoningOptionsForModelRef,
} from './model-capabilities'

describe('model reasoning capabilities', () => {
  it('keeps extended effort controls for current GPT-5.5 family models', () => {
    expect(getSupportedReasoningOptionsForModelRef('openai/gpt-5.5')).toEqual([
      'auto',
      'low',
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

  it('maps configured provider models to model-specific context windows', () => {
    expect(getContextWindowForModelRef('openai/gpt-5.5')).toBe(1_000_000)
    expect(getContextWindowForModelRef('openai/gpt-5.4')).toBe(400_000)
    expect(getContextWindowForModelRef('deepseek/deepseek-v4-pro')).toBe(1_000_000)
    expect(getContextWindowForModelRef('glm/glm-5.2')).toBe(1_000_000)
  })
})
