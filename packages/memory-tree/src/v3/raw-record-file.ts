// Owns projection mutation record validation, scanning, hashing, and quarantine.

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MemoryRawRecord, MemoryStorageMutation } from './contracts.js';
import { MEMORY_RAW_RECORD_VERSION } from './contracts.js';
import { durableAtomicWriteJson, sha256Canonical } from './durable-json.js';
import {
  collectStorageFiles,
  quarantineStorageFile,
  readBoundedJsonFile,
} from './storage-file-io.js';
import { parseMemoryUpdateEvent } from './validation.js';

const IDEMPOTENCY_INDEX_VERSION = 1 as const;

export interface RawRecordIdempotencyEntry {
  version: typeof IDEMPOTENCY_INDEX_VERSION;
  idempotencyKey: string;
  rawRecordId: string;
  rawRecordContentHash: string;
  capturedAt: string;
}

export function rawRecordContentHash(
  record: Omit<MemoryRawRecord, 'contentHash'> | MemoryRawRecord,
): string {
  const { contentHash: _ignored, ...content } = record as MemoryRawRecord;
  return sha256Canonical(content);
}

export function cloneRawRecordStorageMutation(value: MemoryStorageMutation): MemoryStorageMutation {
  if (!value || typeof value !== 'object') throw new Error('Memory projection record requires a storage mutation.');
  const mutation = structuredClone(value);
  if (!['create', 'update', 'archive', 'restore', 'merge'].includes(mutation.kind)) {
    throw new Error(`Unsupported memory raw record mutation: ${String((mutation as { kind?: unknown }).kind)}`);
  }
  return mutation;
}

export function rawRecordMutationAtomIds(mutation: MemoryStorageMutation): string[] {
  if (mutation.kind === 'create') return [mutation.atom.id];
  if (mutation.kind === 'merge') return [...new Set([mutation.targetAtomId, mutation.sourceAtomId])];
  return [mutation.atomId];
}

export async function readRawRecord(path: string, maxBytes: number): Promise<MemoryRawRecord> {
  const value = await readBoundedJsonFile<Partial<MemoryRawRecord>>(path, maxBytes, assertRawRecordBytes);
  if (value.version !== MEMORY_RAW_RECORD_VERSION
    || typeof value.id !== 'string'
    || typeof value.idempotencyKey !== 'string'
    || typeof value.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(value.capturedAt))
    || !Array.isArray(value.atomIds)
    || typeof value.contentHash !== 'string'
    || !value.event
    || !value.mutation) {
    throw new Error('invalid memory raw record');
  }
  const event = parseMemoryUpdateEvent(value.event);
  const mutation = cloneRawRecordStorageMutation(value.mutation);
  const record: MemoryRawRecord = {
    version: MEMORY_RAW_RECORD_VERSION,
    id: value.id,
    idempotencyKey: value.idempotencyKey,
    event,
    mutation,
    atomIds: value.atomIds.map(String),
    capturedAt: value.capturedAt,
    contentHash: value.contentHash,
  };
  if (record.id !== event.id || record.idempotencyKey !== event.idempotencyKey) {
    throw new Error('raw record identity does not match its event');
  }
  if (sha256Canonical(record.atomIds) !== sha256Canonical(rawRecordMutationAtomIds(mutation))) {
    throw new Error('raw record atomIds do not match its mutation');
  }
  if (rawRecordContentHash(record) !== record.contentHash) {
    throw new Error('raw record content hash mismatch');
  }
  return record;
}

export async function collectRawRecordFiles(root: string, limit: number): Promise<string[]> {
  return collectStorageFiles({
    root,
    suffix: '.raw-record.json',
    maximumFiles: limit,
    limitMessage: (maximum) => `Memory raw record scan exceeded the ${maximum} file safety limit.`,
  });
}

export async function readRawRecordIdempotencyEntry(
  path: string,
  idempotencyKey: string,
  maxBytes: number,
): Promise<RawRecordIdempotencyEntry | undefined> {
  if (!existsSync(path)) return undefined;
  const value = await readBoundedJsonFile<Partial<RawRecordIdempotencyEntry>>(
    path,
    maxBytes,
    assertIdempotencyEntryBytes,
  );
  if (value.version !== IDEMPOTENCY_INDEX_VERSION
    || value.idempotencyKey !== idempotencyKey
    || typeof value.rawRecordId !== 'string'
    || typeof value.rawRecordContentHash !== 'string'
    || typeof value.capturedAt !== 'string') {
    throw new Error('Invalid projection record idempotency entry.');
  }
  return value as RawRecordIdempotencyEntry;
}

export async function writeRawRecordIdempotencyEntry(
  path: string,
  record: MemoryRawRecord,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await durableAtomicWriteJson(path, {
    version: IDEMPOTENCY_INDEX_VERSION,
    idempotencyKey: record.idempotencyKey,
    rawRecordId: record.id,
    rawRecordContentHash: record.contentHash,
    capturedAt: record.capturedAt,
  } satisfies RawRecordIdempotencyEntry);
}

export async function quarantineRawRecord(
  path: string,
  destinationDir: string,
  reason: string,
  now: () => Date,
): Promise<void> {
  await quarantineStorageFile({
    source: path,
    destinationDir,
    details: { reason },
    now,
  });
}

export function assertRawRecordBytes(actual: number, maximum: number): void {
  if (!Number.isInteger(maximum) || maximum <= 0) throw new Error(`Invalid raw record size limit: ${maximum}`);
  if (actual > maximum) throw new Error(`Memory raw record exceeds the ${maximum} byte safety limit.`);
}

function assertIdempotencyEntryBytes(actual: number, maximum: number): void {
  if (!Number.isInteger(maximum) || maximum <= 0) {
    throw new Error(`Invalid projection record idempotency size limit: ${maximum}`);
  }
  if (actual > maximum) {
    throw new Error(`Projection record idempotency entry exceeds the ${maximum} byte safety limit.`);
  }
}
