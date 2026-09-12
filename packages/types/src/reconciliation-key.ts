// @littlesheep/types — reconciliation-key.ts
// Bounded recovery key for tool-owned effect reconciliation (option A).
//
// A tool declares which small identifier points at the effect it is about to
// perform (target path, external id, idempotency token). LS persists only that
// value inside the effect intent, never the tool payload, so recovery can look
// the effect up without changing the model-visible transcript or prompt cache
// prefix. Anything outside the allowed shape is dropped (fail closed): an
// unusable key leaves the effect `unknown`, exactly like a tool that declares
// no key at all.

export const RECONCILIATION_KEY_MAX_BYTES = 512;
export const RECONCILIATION_KEY_MAX_FIELDS = 16;
export const RECONCILIATION_KEY_MAX_STRING = 200;
export const RECONCILIATION_KEY_MAX_ARRAY = 16;
export const RECONCILIATION_KEY_MAX_NAME = 64;

export type ReconciliationScalar = string | number | boolean | null;
export type ReconciliationField = ReconciliationScalar | readonly ReconciliationScalar[];
export type ReconciliationValue =
  | ReconciliationScalar
  | readonly ReconciliationScalar[]
  | { readonly [key: string]: ReconciliationField };

/**
 * Validate and normalize a tool-declared reconciliation key.
 * Returns undefined for anything that is not a small, plain, JSON-safe value.
 */
export function boundReconciliationKey(value: unknown): ReconciliationValue | undefined {
  if (value === undefined || value === null) return undefined;
  const candidate = acceptValue(value);
  return candidate !== undefined && fits(candidate) ? candidate : undefined;
}

/** Serialized size guard used when persisting or reading a stored key. */
export function reconciliationKeyFits(value: ReconciliationValue): boolean {
  return fits(value);
}

function isScalar(value: unknown): value is ReconciliationScalar {
  return typeof value === 'string' || typeof value === 'boolean' || value === null
    || (typeof value === 'number' && Number.isFinite(value));
}

/** Accept only scalars, scalar arrays and one level of scalar fields. */
function acceptValue(value: unknown): ReconciliationValue | undefined {
  if (isScalar(value)) return isSafeScalar(value) ? value : undefined;
  if (Array.isArray(value)) return acceptScalarArray(value);
  if (!isPlainObject(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > RECONCILIATION_KEY_MAX_FIELDS) return undefined;
  const result: Record<string, ReconciliationField> = {};
  for (const [key, field] of entries) {
    if (!isName(key)) return undefined;
    if (isScalar(field)) {
      if (!isSafeScalar(field)) return undefined;
      result[key] = field;
      continue;
    }
    if (Array.isArray(field)) {
      const array = acceptScalarArray(field);
      if (!array) return undefined;
      result[key] = array;
      continue;
    }
    return undefined;
  }
  return result;
}

function acceptScalarArray(value: readonly unknown[]): readonly ReconciliationScalar[] | undefined {
  if (value.length === 0 || value.length > RECONCILIATION_KEY_MAX_ARRAY) return undefined;
  for (const item of value) {
    if (!isScalar(item) || !isSafeScalar(item)) return undefined;
  }
  return value as readonly ReconciliationScalar[];
}

function isSafeScalar(value: ReconciliationScalar): boolean {
  return typeof value !== 'string'
    || (value.length <= RECONCILIATION_KEY_MAX_STRING && !hasControlCharacter(value));
}

function isName(value: string): boolean {
  return value.length > 0
    && value.length <= RECONCILIATION_KEY_MAX_NAME
    && !hasControlCharacter(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => /[\u0000-\u001f\u007f]/.test(character));
}

function fits(value: ReconciliationValue): boolean {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' && encoded.length <= RECONCILIATION_KEY_MAX_BYTES;
  } catch {
    return false;
  }
}
