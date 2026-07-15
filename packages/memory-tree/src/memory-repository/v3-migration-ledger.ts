// Writes a validated v2 compatibility ledger into an empty Memory v3 staging root.

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  MemoryManagementAuditRecord,
  MemoryMigrationRecord,
  MemoryResourceManagementAuditRecord,
  MemorySchemaMigrationRecord,
  MemoryWriteAuditRecord,
  QueuedMemoryWrite,
} from '../types.js';
import { durableAtomicWriteJson } from '../v3/durable-json.js';
import type { MemoryV3LedgerSnapshot } from './v3-ledger.js';

const MAX_RECOVERY_RECORDS = 2_000;

export async function writeMemoryV3MigrationLedger(
  dataDir: string,
  snapshot: MemoryV3LedgerSnapshot,
  maxAuditRecords: number,
): Promise<void> {
  const root = join(dataDir, 'memory-tree', 'v3', 'repository');
  const existing = await readdir(root).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  });
  if (existing.length > 0) throw new Error('Memory v3 migration ledger requires an empty staging repository directory.');
  validateRecords(snapshot.writeAudit, isWriteAudit, 'write audit');
  validateRecords(snapshot.managementAudit, isManagementAudit, 'management audit');
  validateRecords(snapshot.resourceManagementAudit, isResourceAudit, 'resource audit');
  validateRecords(snapshot.recoveryQueue, isQueuedWrite, 'recovery record');
  validateRecords(Object.values(snapshot.migrations), isMigration, 'migration record');
  validateRecords(snapshot.schemaMigrations, isSchemaMigration, 'schema migration');
  if (snapshot.writeAudit.length > maxAuditRecords
    || snapshot.managementAudit.length > maxAuditRecords
    || snapshot.resourceManagementAudit.length > maxAuditRecords) {
    throw new Error(`Memory v2 audit history exceeds the v3 hard limit (${maxAuditRecords}).`);
  }
  if (snapshot.recoveryQueue.length > MAX_RECOVERY_RECORDS) {
    throw new Error(`Memory v2 recovery queue exceeds the v3 hard limit (${MAX_RECOVERY_RECORDS}).`);
  }
  await writeRecords(root, 'write-audit', snapshot.writeAudit);
  await writeRecords(root, 'management-audit', snapshot.managementAudit);
  await writeRecords(root, 'resource-audit', snapshot.resourceManagementAudit);
  await writeRecords(root, 'recovery', snapshot.recoveryQueue);
  await writeRecords(root, 'migrations', Object.values(snapshot.migrations));
  await writeRecords(root, 'schema-migrations', snapshot.schemaMigrations);
}

async function writeRecords<T extends { id: string }>(root: string, category: string, records: T[]): Promise<void> {
  for (const record of records) {
    const hash = createHash('sha256').update(record.id, 'utf8').digest('hex');
    await durableAtomicWriteJson(join(root, category, hash.slice(0, 2), `${hash}.json`), record);
  }
}

function validateRecords<T extends { id: string }>(
  values: T[],
  validate: (value: unknown) => value is T,
  label: string,
): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (!validate(value)) throw new Error(`Memory v2 contains an invalid ${label}.`);
    if (ids.has(value.id)) throw new Error(`Memory v2 contains duplicate ${label} id: ${value.id}`);
    ids.add(value.id);
  }
}

function isWriteAudit(value: unknown): value is MemoryWriteAuditRecord {
  return isObjectWithId(value) && typeof value.at === 'string' && typeof value.decision === 'string';
}

function isManagementAudit(value: unknown): value is MemoryManagementAuditRecord {
  return isObjectWithId(value) && typeof value.at === 'string' && typeof value.action === 'string';
}

function isResourceAudit(value: unknown): value is MemoryResourceManagementAuditRecord {
  return isObjectWithId(value) && typeof value.at === 'string' && typeof value.resourceId === 'string';
}

function isQueuedWrite(value: unknown): value is QueuedMemoryWrite {
  return isObjectWithId(value) && typeof value.queuedAt === 'string' && typeof value.attempts === 'number'
    && typeof value.intent === 'object' && value.intent !== null;
}

function isMigration(value: unknown): value is MemoryMigrationRecord {
  return isObjectWithId(value) && typeof value.completedAt === 'string';
}

function isSchemaMigration(value: unknown): value is MemorySchemaMigrationRecord {
  return isObjectWithId(value) && typeof value.startedAt === 'string'
    && typeof value.completedAt === 'string' && typeof value.backupFile === 'string';
}

function isObjectWithId(value: unknown): value is Record<string, unknown> & { id: string } {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
