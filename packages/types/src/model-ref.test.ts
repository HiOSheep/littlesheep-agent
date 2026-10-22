import { describe, expect, it } from 'vitest';
import { parseModelRefParts } from './model-ref.js';

describe('parseModelRefParts', () => {
  it('splits only at the first slash so nested model ids stay intact', () => {
    expect(parseModelRefParts('openrouter/anthropic/claude-3.5-sonnet')).toEqual({
      raw: 'openrouter/anthropic/claude-3.5-sonnet',
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      valid: true,
    });
    expect(parseModelRefParts(' deepseek/deepseek-v4-flash ')).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      valid: true,
    });
  });

  it('marks missing separators and malformed parts invalid instead of guessing', () => {
    expect(parseModelRefParts('deepseek-v4-flash')).toMatchObject({ provider: null, model: 'deepseek-v4-flash', valid: false, reason: 'missing_separator' });
    expect(parseModelRefParts('/model')).toMatchObject({ valid: false, reason: 'missing_separator' });
    expect(parseModelRefParts('provider/')).toMatchObject({ valid: false, reason: 'invalid_model' });
    expect(parseModelRefParts(' provider /model')).toMatchObject({ valid: false, reason: 'invalid_provider' });
    expect(parseModelRefParts('provider/model name')).toMatchObject({ valid: false, reason: 'invalid_model' });
    expect(parseModelRefParts('provider/https://model')).toMatchObject({ valid: false, reason: 'invalid_model' });
    expect(parseModelRefParts('')).toMatchObject({ valid: false, reason: 'empty' });
    expect(parseModelRefParts(undefined)).toMatchObject({ valid: false, reason: 'empty' });
  });
});
