/**
 * Canonical model-reference parsing.
 *
 * A model reference is `provider/model`; the model segment may itself contain
 * slashes (for example OpenRouter's `openrouter/anthropic/claude-3.5-sonnet`),
 * so only the first slash separates the provider. Parsing is pure and shared by
 * config, runner, harness, context and renderer instead of each caller
 * re-implementing `indexOf('/')`.
 */

export type ModelRefInvalidReason = 'empty' | 'missing_separator' | 'invalid_provider' | 'invalid_model';

export interface ModelRefParts {
  raw: string;
  provider: string | null;
  model: string | null;
  valid: boolean;
  reason?: ModelRefInvalidReason;
}

function invalid(raw: string, model: string | null, reason: ModelRefInvalidReason): ModelRefParts {
  return { raw, provider: null, model, valid: false, reason };
}

export function parseModelRefParts(ref: string | null | undefined): ModelRefParts {
  const raw = typeof ref === 'string' ? ref.trim() : '';
  if (!raw) return invalid(raw, null, 'empty');
  const separator = raw.indexOf('/');
  if (separator <= 0) return invalid(raw, raw, 'missing_separator');
  if (separator === raw.length - 1) return invalid(raw, null, 'invalid_model');
  const provider = raw.slice(0, separator);
  const model = raw.slice(separator + 1);
  if (/\s/u.test(provider) || provider.includes('://')) return invalid(raw, model, 'invalid_provider');
  if (!model.trim() || /\s/u.test(model) || model.includes('://')) return invalid(raw, model, 'invalid_model');
  return { raw, provider, model, valid: true };
}
