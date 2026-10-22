import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, selectDefaultModelForAvailableProvider } from './defaults.js';
import { parseModelRef, parseModelRefParts } from './model-ref.js';

describe('config model refs', () => {
  it('keeps nested model ids and rejects malformed refs', () => {
    expect(parseModelRef('openrouter/anthropic/claude-3.5-sonnet')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
    });
    expect(parseModelRefParts('deepseek-v4-flash')).toMatchObject({ valid: false, reason: 'missing_separator' });
    expect(() => parseModelRef('deepseek-v4-flash')).toThrow(/invalid model ref/);
    expect(() => parseModelRef('provider/')).toThrow(/invalid model ref/);
  });

  it('does not silently switch a nested default model to the provider’s first model', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.providers = [{
      id: 'openrouter',
      name: 'OpenRouter',
      baseURL: 'https://openrouter.example/v1',
      apiKey: '$OPENROUTER_API_KEY',
      models: ['anthropic/claude-3.5-haiku', 'anthropic/claude-3.5-sonnet'],
    }];
    config.agents.defaults.model = 'openrouter/anthropic/claude-3.5-sonnet';

    expect(selectDefaultModelForAvailableProvider(config, () => true)).toBe('openrouter/anthropic/claude-3.5-sonnet');
  });
});
