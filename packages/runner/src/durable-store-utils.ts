import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';

export const DURABLE_STORE_MAX_ID_LENGTH = 256 as const;
export const DURABLE_STORE_MAX_REASON_LENGTH = 4_096 as const;
export const DURABLE_STORE_MAX_PAYLOAD_DEPTH = 8;
export const DURABLE_STORE_MAX_PAYLOAD_NODES = 2_048;
export const DURABLE_STORE_MAX_PAYLOAD_KEYS = 256;
export const DURABLE_STORE_MAX_STRING_LENGTH = 16 * 1024;

export function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  if (normalized.length > DURABLE_STORE_MAX_ID_LENGTH) {
    throw new Error(`${label} exceeds ${DURABLE_STORE_MAX_ID_LENGTH} characters`);
  }
  return normalized;
}

export function normalizeReason(value: unknown, label = 'reason'): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty`);
  if (normalized.length > DURABLE_STORE_MAX_REASON_LENGTH) {
    throw new Error(`${label} exceeds ${DURABLE_STORE_MAX_REASON_LENGTH} characters`);
  }
  return normalized;
}

export function normalizeTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be an ISO timestamp`);
  const normalized = value.trim();
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${label} must be an ISO timestamp`);
  return normalized;
}

export function randomId(): string {
  return randomUUID();
}

/**
 * Normalize JSON-compatible values while enforcing a bounded payload shape.
 * Sorting is performed by canonicalSerialize, so object insertion order never
 * becomes part of an event identity.
 */
export function normalizeJsonValue(value: unknown, label = 'payload'): unknown {
  const state = { nodes: 0 };
  return normalizeJsonValueInner(value, 0, state, label);
}

function normalizeJsonValueInner(
  value: unknown,
  depth: number,
  state: { nodes: number },
  label: string,
): unknown {
  state.nodes += 1;
  if (state.nodes > DURABLE_STORE_MAX_PAYLOAD_NODES) {
    throw new Error(`${label} exceeds ${DURABLE_STORE_MAX_PAYLOAD_NODES} values`);
  }
  if (depth > DURABLE_STORE_MAX_PAYLOAD_DEPTH) {
    throw new Error(`${label} exceeds depth ${DURABLE_STORE_MAX_PAYLOAD_DEPTH}`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.normalize('NFC');
    if (normalized.length > DURABLE_STORE_MAX_STRING_LENGTH) {
      throw new Error(`${label} contains an overlong string`);
    }
    return normalized;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new Error(`${label} contains a non-JSON value`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJsonValueInner(item, depth + 1, state, `${label}[${index}]`));
  }
  const record = value as Record<string, unknown>;
  if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) {
    throw new Error(`${label} must contain plain objects`);
  }
  const keys = Object.keys(record);
  if (keys.length > DURABLE_STORE_MAX_PAYLOAD_KEYS) {
    throw new Error(`${label} exceeds ${DURABLE_STORE_MAX_PAYLOAD_KEYS} object keys`);
  }
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const normalizedKey = key.normalize('NFC');
    if (normalizedKey.length > DURABLE_STORE_MAX_STRING_LENGTH) {
      throw new Error(`${label} contains an overlong object key`);
    }
    if (Object.prototype.hasOwnProperty.call(output, normalizedKey)) {
      throw new Error(`${label} contains duplicate normalized object keys`);
    }
    output[normalizedKey] = normalizeJsonValueInner(record[key], depth + 1, state, `${label}.${normalizedKey}`);
  }
  return output;
}

export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
  return sorted;
}

export function hashParts(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

export async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
  const directory = file.slice(0, Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/')));
  if (directory) await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, canonicalSerialize(value), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function parseJson(raw: string, file: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`durable store: corrupt JSON in ${file}: ${(error as Error).message}`);
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = value === undefined ? fallback : Math.floor(value);
  if (!Number.isFinite(candidate) || candidate < min || candidate > max) {
    throw new Error(`value must be an integer between ${min} and ${max}`);
  }
  return candidate;
}
