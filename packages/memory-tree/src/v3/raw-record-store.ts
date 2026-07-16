// Persists append-only Memory v3 projection mutation records for recovery and audit.

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
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
  rawRecordMutationAtomIds,
  rawRecordContentHash,
  quarantineRawRecord,
  readRawRecord,
} from './raw-record-file.js';
import { MemoryRawRecordCommitStore } from './raw-record-commit-store.js';
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

export class MemoryRawRecordStore {
  readonly rootDir: string;
  readonly quarantineDir: string;
  private readonly now: () => Date;
  private readonly maxRawRecordBytes: number;
  private readonly maxScanFiles: number;
  private readonly log?: MemoryRawRecordStoreOptions['log'];
  private readonly records = new Map<string, MemoryRawRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly commitStore: MemoryRawRecordCommitStore;
  private initialized = false;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryRawRecordStoreOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'raw-records');
    this.quarantineDir = join(options.dataDir, 'memory-tree', 'v3', 'quarantine', 'raw-records');
    this.now = options.now ?? (() => new Date());
    this.maxRawRecordBytes = options.maxRawRecordBytes ?? DEFAULT_MAX_RAW_RECORD_BYTES;
    this.maxScanFiles = options.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
    this.log = options.log;
    this.commitStore = new MemoryRawRecordCommitStore({
      dataDir: options.dataDir,
      now: this.now,
      maxReceiptBytes: this.maxRawRecordBytes,
      maxScanFiles: this.maxScanFiles,
      resolveRawRecord: (rawRecordId) => this.records.get(rawRecordId),
    });
  }

  async initialize(): Promise<MemoryRawRecordScanResult> {
    return this.exclusive(async () => {
      await mkdir(this.rootDir, { recursive: true });
      await mkdir(this.quarantineDir, { recursive: true });
      this.records.clear();
      this.idempotency.clear();
      let quarantined = 0;
      for (const path of await collectRawRecordFiles(this.rootDir, this.maxScanFiles)) {
        try {
          const record = await readRawRecord(path, this.maxRawRecordBytes);
          if (this.records.has(record.id) || this.idempotency.has(record.idempotencyKey)) {
            throw new Error('duplicate record id or idempotency key');
          }
          this.records.set(record.id, record);
          this.idempotency.set(record.idempotencyKey, record.id);
        } catch (error) {
          quarantined += 1;
          await quarantineRawRecord(path, this.quarantineDir, errorMessage(error), this.now);
        }
      }
      await this.commitStore.initialize();
      this.initialized = true;
      return { count: this.records.size, quarantined };
    });
  }

  async capture(eventValue: MemoryUpdateEvent, mutationValue: MemoryStorageMutation): Promise<MemoryRawRecord> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const event = parseMemoryUpdateEvent(structuredClone(eventValue));
      const mutation = cloneRawRecordStorageMutation(mutationValue);
      const priorId = this.idempotency.get(event.idempotencyKey);
      const existing = this.records.get(priorId ?? event.id);
      if (existing) {
        if (sameRawRecordPayload(existing, event, mutation)) return structuredClone(existing);
        throw new MemoryRawRecordConflictError(existing.id);
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
      this.records.set(record.id, record);
      this.idempotency.set(record.idempotencyKey, record.id);
      return structuredClone(record);
    });
  }

  async get(rawRecordId: string): Promise<MemoryRawRecord | undefined> {
    await this.ensureInitialized();
    const record = this.records.get(rawRecordId);
    return record ? structuredClone(record) : undefined;
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
    return [...this.records.values()]
      .filter((record) => record.atomIds.includes(atomId))
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id))
      .slice(0, Math.max(0, Math.floor(limit)))
      .map((record) => structuredClone(record));
  }

  async *batches(batchSize = 250): AsyncGenerator<MemoryRawRecord[]> {
    await this.ensureInitialized();
    const boundedSize = Math.max(1, Math.min(1_000, Math.floor(batchSize)));
    let batch: MemoryRawRecord[] = [];
    for (const record of this.records.values()) {
      batch.push(structuredClone(record));
      if (batch.length < boundedSize) continue;
      yield batch;
      batch = [];
    }
    if (batch.length > 0) yield batch;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.records.size;
  }

  private pathFor(rawRecordId: string): string {
    const digest = createHash('sha256').update(rawRecordId, 'utf8').digest('hex');
    return join(this.rootDir, digest.slice(0, 2), `${digest}.raw-record.json`);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
