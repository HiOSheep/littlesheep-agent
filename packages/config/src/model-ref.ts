// Canonical model-reference parsing for the config package. Kept dependency-free
// so config remains the base of the configuration graph; @littlesheep/types has
// the same pure helper for packages that do not depend on config.
export type ConfigModelRefInvalidReason = 'empty' | 'missing_separator' | 'invalid_provider' | 'invalid_model';

export interface ConfigModelRefParts {
  raw: string;
  provider: string | null;
  model: string | null;
  valid: boolean;
  reason?: ConfigModelRefInvalidReason;
}

function invalid(raw: string, model: string | null, reason: ConfigModelRefInvalidReason): ConfigModelRefParts {
  return { raw, provider: null, model, valid: false, reason };
}

export function parseModelRefParts(ref: string | null | undefined): ConfigModelRefParts {
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

/** Parse a model ref "provider/model" into parts, rejecting malformed refs. */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const parsed = parseModelRefParts(ref);
  if (!parsed.valid) {
    throw new Error(`config: invalid model ref "${ref}" (expected "provider/model")`);
  }
  return { provider: parsed.provider!, model: parsed.model! };
}
