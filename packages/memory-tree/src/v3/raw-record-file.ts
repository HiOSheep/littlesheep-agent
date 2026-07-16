// Owns projection mutation record validation, scanning, hashing, and quarantine.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MemoryRawRecord, MemoryStorageMutation } from './contracts.js';
import { MEMORY_RAW_RECORD_VERSION } from './contracts.js';
import { durableAtomicWriteJson, sha256Canonical } from './durable-json.js';
import { parseMemoryUpdateEvent } from './validation.js';

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
  const bytes = await readFile(path);
  assertRawRecordBytes(bytes.byteLength, maxBytes);
  const value = JSON.parse(bytes.toString('utf8')) as Partial<MemoryRawRecord>;
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
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.raw-record.json')) files.push(path);
      if (files.length > limit) throw new Error(`Memory raw record scan exceeded the ${limit} file safety limit.`);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export async function quarantineRawRecord(
  path: string,
  destinationDir: string,
  reason: string,
  now: () => Date,
): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  const destination = join(
    destinationDir,
    `${basename(path)}.${now().toISOString().replace(/[:.]/gu, '-')}-${randomBytes(4).toString('hex')}`,
  );
  await rename(path, destination);
  await durableAtomicWriteJson(`${destination}.reason.json`, {
    version: 1,
    reason,
    quarantinedAt: now().toISOString(),
  });
}

export function assertRawRecordBytes(actual: number, maximum: number): void {
  if (!Number.isInteger(maximum) || maximum <= 0) throw new Error(`Invalid raw record size limit: ${maximum}`);
  if (actual > maximum) throw new Error(`Memory raw record exceeds the ${maximum} byte safety limit.`);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
