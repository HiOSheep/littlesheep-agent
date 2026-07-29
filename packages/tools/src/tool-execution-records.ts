// Bounded, value-redacted summaries and fingerprints for tool audit records.

import { createHash } from 'node:crypto';

const MAX_ERROR_CHARS = 2_048;
const MAX_HASH_INPUT_CHARS = 64 * 1_024;
const MAX_HASH_DEPTH = 32;
const MAX_HASH_COLLECTION_ITEMS = 1_024;

export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return typeof input;
  const keys: string[] = [];
  for (const key in input as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    keys.push(key);
    if (keys.length >= 20) break;
  }
  return keys.length > 0 ? `object keys: ${keys.join(', ')}` : 'empty object';
}

export function hashToolInput(value: unknown): string {
  try {
    return createHash('sha256').update(stableSerialize(value), 'utf8').digest('hex');
  } catch {
    return createHash('sha256').update('[unserializable]', 'utf8').digest('hex');
  }
}

export function boundedError(error: unknown): string {
  return boundedText(errorMessage(error));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function boundedText(value: string): string {
  return value.slice(0, MAX_ERROR_CHARS);
}

export function boundedInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function stableSerialize(value: unknown): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  let remaining = MAX_HASH_INPUT_CHARS;
  const append = (text: string) => {
    if (remaining <= 0) return;
    const bounded = text.slice(0, remaining);
    parts.push(bounded);
    remaining -= bounded.length;
  };
  const visit = (item: unknown, depth: number): void => {
    if (remaining <= 0) return;
    if (depth > MAX_HASH_DEPTH) {
      append('[max-depth]');
      return;
    }
    if (!item || typeof item !== 'object') {
      append(JSON.stringify(item) ?? 'null');
      return;
    }
    if (seen.has(item)) {
      append('[circular]');
      return;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      append('[');
      const limit = Math.min(item.length, MAX_HASH_COLLECTION_ITEMS);
      for (let index = 0; index < limit && remaining > 0; index += 1) {
        if (index > 0) append(',');
        visit(item[index], depth + 1);
      }
      if (item.length > limit) append(`,[remaining:${item.length - limit}]`);
      append(']');
      return;
    }
    const record = item as Record<string, unknown>;
    const keys: string[] = [];
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      keys.push(key);
      if (keys.length >= MAX_HASH_COLLECTION_ITEMS) break;
    }
    keys.sort();
    append('{');
    for (const [index, key] of keys.entries()) {
      if (index > 0) append(',');
      append(`${JSON.stringify(key)}:`);
      visit(record[key], depth + 1);
    }
    if (keys.length >= MAX_HASH_COLLECTION_ITEMS) append(',"[remaining]":true');
    append('}');
  };
  visit(value, 0);
  if (remaining <= 0) parts.push('[truncated]');
  return parts.join('');
}
