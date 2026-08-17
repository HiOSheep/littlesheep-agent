// Persists append-only Memory v3 projection mutation records for recovery and audit.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  MemoryRawRecord,
  MemoryRawRecordCommitReceipt,
  MemoryStorageMutation,
  MemoryUpdateEvent,
} from './contracts.js';
import { MEMORY_RAW_RECORD_VERSION } from './contracts.js';
import { durableAtomicWriteJson, sha256Canonical } from './durable-json.js';
import {
  assertRawRecordBytes,
  cloneRawRecordStorageMutation,
  collectRawRecordFiles,
  type RawRecordIdempotencyEntry,
  rawRecordMutationAtomIds,
  rawRecordContentHash,
  quarantineRawRecord,
  readRawRecord,
  readRawRecordIdempotencyEntry,
  writeRawRecordIdempotencyEntry,
} from './raw-record-file.js';
import { MemoryRawRecordCommitStore } from './raw-record-commit-store.js';
import { quarantineStorageFile } from './storage-file-io.js';
import { parseMemoryUpdateEvent } from './validation.js';

export { rawRecordContentHash } from './raw-record-file.js';

const DEFAULT_MAX_RAW_RECORD_BYTES = 3_000_000;
const DEFAULT_MAX_SCAN_FILES = 1_000_000;

export interface MemoryRawRecordStoreOptions {
  dataDir: string;
  now?: () => Date;
  maxRawRecordBytes?: number;
  maxScanFiles?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface MemoryRawRecordScanResult {
  count: number;
  quarantined: number;
}

export class MemoryRawRecordConflictError extends Error {
  constructor(readonly rawRecordId: string) {
    super(`Memory projection record ${rawRecordId} already exists with different content.`);
    this.name = 'MemoryRawRecordConflictError';
  }
}

/**
 * Authoritative projection records stay on disk. Runtime memory only retains
 * the short-lived mutation queue; records and idempotency history are loaded
 * on demand so storage growth does not become resident-memory growth.
 */
export class MemoryRawRecordStore {
  readonly rootDir: string;
  readonly quarantineDir: string;
  readonly idempotencyDir: string;
  private readonly idempotencyQuarantineDir: string;
  private readonly now: () => Date;
  private readonly maxRawRecordBytes: number;
  private readonly maxScanFiles: number;
  private readonly log?: MemoryRawRecordStoreOptions['log'];
  private readonly commitStore: MemoryRawRecordCommitStore;
  private initialized = false;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryRawRecordStoreOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'raw-records');
    this.quarantineDir = join(options.dataDir, 'memory-tree', 'v3', 'quarantine', 'raw-records');
    this.idempotencyDir = join(options.dataDir, 'memory-tree', 'v3', 'raw-record-idempotency');
    this.idempotencyQuarantineDir = join(options.dataDir, 'memory-tree', 'v3', 'quarantine', 'raw-record-idempotency');
    this.now = options.now ?? (() => new Date());
    this.maxRawRecordBytes = options.maxRawRecordBytes ?? DEFAULT_MAX_RAW_RECORD_BYTES;
    this.maxScanFiles = options.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
    this.log = options.log;
    this.commitStore = new MemoryRawRecordCommitStore({
      dataDir: options.dataDir,
      now: this.now,
      maxReceiptBytes: this.maxRawRecordBytes,
      maxScanFiles: this.maxScanFiles,
      resolveRawRecord: (rawRecordId) => this.readRecordDirect(rawRecordId),
    });
  }

  async initialize(): Promise<MemoryRawRecordScanResult> {
    return this.exclusive(async () => {
      await Promise.all([
        mkdir(this.rootDir, { recursive: true }),
        mkdir(this.quarantineDir, { recursive: true }),
        mkdir(this.idempotencyDir, { recursive: true }),
        mkdir(this.idempotencyQuarantineDir, { recursive: true }),
      ]);
      let count = 0;
      let quarantined = 0;
      for (const path of await collectRawRecordFiles(this.rootDir, this.maxScanFiles)) {
        try {
          const record = await readRawRecord(path, this.maxRawRecordBytes);
          await this.reconcileIdempotencyEntry(record);
          count += 1;
        } catch (error) {
          if (errorCode(error)) throw error;
          quarantined += 1;
          await quarantineRawRecord(path, this.quarantineDir, errorMessage(error), this.now);
        }
      }
      this.initialized = true;
      try {
        await this.commitStore.initialize();
      } catch (error) {
        this.initialized = false;
        throw error;
      }
      return { count, quarantined };
    });
  }

  async capture(eventValue: MemoryUpdateEvent, mutationValue: MemoryStorageMutation): Promise<MemoryRawRecord> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const event = parseMemoryUpdateEvent(structuredClone(eventValue));
      const mutation = cloneRawRecordStorageMutation(mutationValue);
      const existingById = await this.readRecordDirect(event.id);
      if (existingById) {
        if (sameRawRecordPayload(existingById, event, mutation)) return existingById;
        throw new MemoryRawRecordConflictError(existingById.id);
      }
      const indexed = await readRawRecordIdempotencyEntry(
        this.idempotencyPath(event.idempotencyKey),
        event.idempotencyKey,
        this.maxRawRecordBytes,
      );
      if (indexed) {
        const existing = await this.readRecordDirect(indexed.rawRecordId);
        if (existing && sameRawRecordPayload(existing, event, mutation)) return existing;
        if (existing) throw new MemoryRawRecordConflictError(existing.id);
        await unlink(this.idempotencyPath(event.idempotencyKey)).catch(() => undefined);
      }

      const atomIds = rawRecordMutationAtomIds(mutation);
      const recordWithoutHash: Omit<MemoryRawRecord, 'contentHash'> = {
        version: MEMORY_RAW_RECORD_VERSION,
        id: event.id,
        idempotencyKey: event.idempotencyKey,
        event,
        mutation,
        atomIds,
        capturedAt: this.now().toISOString(),
      };
      const record: MemoryRawRecord = {
        ...recordWithoutHash,
        contentHash: rawRecordContentHash(recordWithoutHash),
      };
      assertRawRecordBytes(Buffer.byteLength(JSON.stringify(record), 'utf8'), this.maxRawRecordBytes);
      await durableAtomicWriteJson(this.pathFor(record.id), record);
      await writeRawRecordIdempotencyEntry(this.idempotencyPath(record.idempotencyKey), record);
      return structuredClone(record);
    });
  }

  async get(rawRecordId: string): Promise<MemoryRawRecord | undefined> {
    await this.ensureInitialized();
    return this.readRecordDirect(rawRecordId);
  }

  async markCommitted(rawRecordId: string, operationId: string): Promise<MemoryRawRecordCommitReceipt> {
    await this.ensureInitialized();
    return this.commitStore.markCommitted(rawRecordId, operationId);
  }

  async getCommitReceipt(rawRecordId: string): Promise<MemoryRawRecordCommitReceipt | undefined> {
    await this.ensureInitialized();
    return this.commitStore.get(rawRecordId);
  }

  async listForAtom(atomId: string, limit = 100): Promise<MemoryRawRecord[]> {
    await this.ensureInitialized();
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (boundedLimit === 0) return [];
    const records: MemoryRawRecord[] = [];
    for (const path of await collectRawRecordFiles(this.rootDir, this.maxScanFiles)) {
      const record = await readRawRecord(path, this.maxRawRecordBytes);
      if (!record.atomIds.includes(atomId)) continue;
      records.push(record);
      records.sort(compareNewestRecord);
      if (records.length > boundedLimit) records.pop();
    }
    return records.map((record) => structuredClone(record));
  }

  async *batches(batchSize = 250): AsyncGenerator<MemoryRawRecord[]> {
    await this.ensureInitialized();
    const boundedSize = Math.max(1, Math.min(1_000, Math.floor(batchSize)));
    let batch: MemoryRawRecord[] = [];
    for (const path of await collectRawRecordFiles(this.rootDir, this.maxScanFiles)) {
      batch.push(await readRawRecord(path, this.maxRawRecordBytes));
      if (batch.length < boundedSize) continue;
      yield batch;
      batch = [];
    }
    if (batch.length > 0) yield batch;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return (await collectRawRecordFiles(this.rootDir, this.maxScanFiles)).length;
  }

  private pathFor(rawRecordId: string): string {
    const digest = createHash('sha256').update(rawRecordId, 'utf8').digest('hex');
    return join(this.rootDir, digest.slice(0, 2), `${digest}.raw-record.json`);
  }

  private idempotencyPath(idempotencyKey: string): string {
    const digest = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
    return join(this.idempotencyDir, digest.slice(0, 2), `${digest}.idempotency.json`);
  }

  private async readRecordDirect(rawRecordId: string): Promise<MemoryRawRecord | undefined> {
    const path = this.pathFor(rawRecordId);
    return existsSync(path) ? readRawRecord(path, this.maxRawRecordBytes) : undefined;
  }

  private async reconcileIdempotencyEntry(record: MemoryRawRecord): Promise<void> {
    let existing: RawRecordIdempotencyEntry | undefined;
    try {
      existing = await readRawRecordIdempotencyEntry(
        this.idempotencyPath(record.idempotencyKey),
        record.idempotencyKey,
        this.maxRawRecordBytes,
      );
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') existing = undefined;
      else if (code) throw error;
      else await quarantineStorageFile({
        source: this.idempotencyPath(record.idempotencyKey),
        destinationDir: this.idempotencyQuarantineDir,
        details: { reason: errorMessage(error) },
        now: this.now,
      });
    }
    if (!existing) {
      await writeRawRecordIdempotencyEntry(this.idempotencyPath(record.idempotencyKey), record);
      return;
    }
    if (existing.rawRecordId !== record.id || existing.rawRecordContentHash !== record.contentHash) {
      throw new Error('duplicate record idempotency key');
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await prior;
    try {
      return await operation();
    } catch (error) {
      this.log?.('error', 'memory-v3: projection record persistence failed', error);
      throw error;
    } finally {
      release();
    }
  }
}

function sameRawRecordPayload(
  existing: MemoryRawRecord,
  event: MemoryUpdateEvent,
  mutation: MemoryStorageMutation,
): boolean {
  return sha256Canonical(existing.event) === sha256Canonical(event)
    && sha256Canonical(existing.mutation) === sha256Canonical(mutation);
}

function compareNewestRecord(left: MemoryRawRecord, right: MemoryRawRecord): number {
  return right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
