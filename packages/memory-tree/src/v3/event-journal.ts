// Owns bounded, durable Memory v3 event and operation recovery journals.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  MemoryEventJournalRecord,
  MemoryJournalState,
  MemoryOperationKind,
  MemoryOperationRecord,
  MemoryUpdateEvent,
} from './contracts.js';
import { durableAtomicWriteJson } from './durable-json.js';
import {
  parseMemoryEventJournalRecord,
  parseMemoryOperationRecord,
  parseMemoryUpdateEvent,
} from './validation.js';

const DEFAULT_MAX_COMMITTED = 1_000;
const DEFAULT_MAX_TOTAL = 5_000;
const DEFAULT_MAX_RECORD_BYTES = 3_000_000;

interface JournalOptions {
  dataDir: string;
  now?: () => Date;
  maxCommittedRecords?: number;
  maxTotalRecords?: number;
  maxRecordBytes?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface MemoryEventJournalOptions extends JournalOptions {}
export interface MemoryOperationJournalOptions extends JournalOptions {}

export interface StartMemoryOperationInput {
  id: string;
  idempotencyKey: string;
  kind: MemoryOperationKind;
  atomIds: string[];
  eventIds: string[];
  expectedRevisions?: Record<string, number>;
}

export class MemoryEventJournal {
  readonly rootDir: string;
  private readonly quarantineDir: string;
  private readonly now: () => Date;
  private readonly maxCommittedRecords: number;
  private readonly maxTotalRecords: number;
  private readonly maxRecordBytes: number;
  private readonly log?: JournalOptions['log'];
  private readonly records = new Map<string, MemoryEventJournalRecord>();
  private readonly idempotency = new Map<string, string>();
  private initialized = false;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryEventJournalOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'events');
    this.quarantineDir = join(options.dataDir, 'memory-tree', 'v3', 'quarantine', 'events');
    this.now = options.now ?? (() => new Date());
    this.maxCommittedRecords = options.maxCommittedRecords ?? DEFAULT_MAX_COMMITTED;
    this.maxTotalRecords = options.maxTotalRecords ?? DEFAULT_MAX_TOTAL;
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.log = options.log;
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      await mkdir(this.rootDir, { recursive: true });
      await mkdir(this.quarantineDir, { recursive: true });
      this.records.clear();
      this.idempotency.clear();
      for (const path of await collectJournalFiles(this.rootDir, '.event.json', this.maxTotalRecords)) {
        try {
          const bytes = await readFile(path);
          assertRecordBytes(bytes.byteLength, this.maxRecordBytes, 'event');
          const record = parseMemoryEventJournalRecord(JSON.parse(bytes.toString('utf8')) as unknown);
          if (this.records.has(record.event.id) || this.idempotency.has(record.event.idempotencyKey)) {
            await quarantine(path, this.quarantineDir, 'duplicate event id or idempotency key', this.now);
            continue;
          }
          this.records.set(record.event.id, record);
          this.idempotency.set(record.event.idempotencyKey, record.event.id);
        } catch (error) {
          await quarantine(path, this.quarantineDir, errorMessage(error), this.now);
        }
      }
      this.initialized = true;
      await this.pruneCommitted();
    });
  }

  async capture(value: MemoryUpdateEvent): Promise<MemoryEventJournalRecord> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const event = parseMemoryUpdateEvent(structuredClone(value));
      const priorId = this.idempotency.get(event.idempotencyKey);
      if (priorId) return structuredClone(this.records.get(priorId)!);
      if (this.records.has(event.id)) throw new Error(`Memory event id already exists: ${event.id}`);
      this.ensureCapacity();
      const timestamp = this.now().toISOString();
      const record: MemoryEventJournalRecord = {
        event,
        state: 'pending',
        attempts: 0,
        capturedAt: timestamp,
        updatedAt: timestamp,
      };
      assertRecordBytes(Buffer.byteLength(JSON.stringify(record), 'utf8'), this.maxRecordBytes, 'event');
      await durableAtomicWriteJson(this.pathFor(event.id), record);
      this.records.set(event.id, record);
      this.idempotency.set(event.idempotencyKey, event.id);
      return structuredClone(record);
    });
  }

  async markCommitted(eventId: string, operationId?: string): Promise<MemoryEventJournalRecord> {
    return this.updateState(eventId, 'committed', undefined, operationId);
  }

  async markRecovery(eventId: string, error: string, operationId?: string): Promise<MemoryEventJournalRecord> {
    return this.updateState(eventId, 'recovery', error, operationId);
  }

  async markPending(eventId: string): Promise<MemoryEventJournalRecord> {
    return this.updateState(eventId, 'pending');
  }

  async get(eventId: string): Promise<MemoryEventJournalRecord | undefined> {
    await this.ensureInitialized();
    const record = this.records.get(eventId);
    return record ? structuredClone(record) : undefined;
  }

  async knownEventIds(eventIds: readonly string[]): Promise<Set<string>> {
    await this.ensureInitialized();
    return new Set(eventIds.filter((eventId) => this.records.has(eventId)));
  }

  async listOutstanding(limit = 1_000): Promise<MemoryEventJournalRecord[]> {
    await this.ensureInitialized();
    return [...this.records.values()]
      .filter((record) => record.state !== 'committed')
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
      .slice(0, Math.max(0, limit))
      .map((record) => structuredClone(record));
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.records.size;
  }

  private async updateState(
    eventId: string,
    state: MemoryJournalState,
    error?: string,
    operationId?: string,
  ): Promise<MemoryEventJournalRecord> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const prior = this.records.get(eventId);
      if (!prior) throw new Error(`Memory event not found: ${eventId}`);
      const next: MemoryEventJournalRecord = {
        ...prior,
        state,
        attempts: state === 'committed' ? prior.attempts : prior.attempts + 1,
        operationId: operationId ?? prior.operationId,
        lastError: error,
        updatedAt: this.now().toISOString(),
      };
      assertRecordBytes(Buffer.byteLength(JSON.stringify(next), 'utf8'), this.maxRecordBytes, 'event');
      await durableAtomicWriteJson(this.pathFor(eventId), next);
      this.records.set(eventId, next);
      if (state === 'committed') await this.pruneCommitted();
      return structuredClone(next);
    });
  }

  private pathFor(eventId: string): string {
    const digest = journalDigest(eventId);
    return join(this.rootDir, digest.slice(0, 2), `${digest}.event.json`);
  }

  private ensureCapacity(): void {
    if (this.records.size >= this.maxTotalRecords) {
      throw new Error(`Memory event journal reached its ${this.maxTotalRecords} record safety limit.`);
    }
  }

  private async pruneCommitted(): Promise<void> {
    const committed = [...this.records.values()]
      .filter((record) => record.state === 'committed')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const record of committed.slice(this.maxCommittedRecords)) {
      await unlink(this.pathFor(record.event.id)).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
      this.records.delete(record.event.id);
      this.idempotency.delete(record.event.idempotencyKey);
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
      this.log?.('error', 'memory-v3: event journal mutation failed', error);
      throw error;
    } finally {
      release();
    }
  }
}

export class MemoryOperationJournal {
  readonly rootDir: string;
  private readonly quarantineDir: string;
  private readonly now: () => Date;
  private readonly maxCommittedRecords: number;
  private readonly maxTotalRecords: number;
  private readonly maxRecordBytes: number;
  private readonly log?: JournalOptions['log'];
  private readonly records = new Map<string, MemoryOperationRecord>();
  private readonly idempotency = new Map<string, string>();
  private initialized = false;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryOperationJournalOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'operations');
    this.quarantineDir = join(options.dataDir, 'memory-tree', 'v3', 'quarantine', 'operations');
    this.now = options.now ?? (() => new Date());
    this.maxCommittedRecords = options.maxCommittedRecords ?? DEFAULT_MAX_COMMITTED;
    this.maxTotalRecords = options.maxTotalRecords ?? DEFAULT_MAX_TOTAL;
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.log = options.log;
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      await mkdir(this.rootDir, { recursive: true });
      await mkdir(this.quarantineDir, { recursive: true });
      this.records.clear();
      this.idempotency.clear();
      for (const path of await collectJournalFiles(this.rootDir, '.operation.json', this.maxTotalRecords)) {
        try {
          const bytes = await readFile(path);
          assertRecordBytes(bytes.byteLength, this.maxRecordBytes, 'operation');
          const record = parseMemoryOperationRecord(JSON.parse(bytes.toString('utf8')) as unknown);
          if (this.records.has(record.id) || this.idempotency.has(record.idempotencyKey)) {
            await quarantine(path, this.quarantineDir, 'duplicate operation id or idempotency key', this.now);
            continue;
          }
          this.records.set(record.id, record);
          this.idempotency.set(record.idempotencyKey, record.id);
        } catch (error) {
          await quarantine(path, this.quarantineDir, errorMessage(error), this.now);
        }
      }
      this.initialized = true;
      await this.pruneCommitted();
    });
  }

  async start(input: StartMemoryOperationInput): Promise<MemoryOperationRecord> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const priorId = this.idempotency.get(input.idempotencyKey);
      if (priorId) return structuredClone(this.records.get(priorId)!);
      if (this.records.has(input.id)) throw new Error(`Memory operation id already exists: ${input.id}`);
      this.ensureCapacity();
      const timestamp = this.now().toISOString();
      const record = parseMemoryOperationRecord({
        version: 1,
        id: input.id,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        atomIds: [...new Set(input.atomIds)],
        eventIds: [...new Set(input.eventIds)],
        expectedRevisions: { ...(input.expectedRevisions ?? {}) },
        state: 'pending',
        attempts: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      });
      assertRecordBytes(Buffer.byteLength(JSON.stringify(record), 'utf8'), this.maxRecordBytes, 'operation');
      await durableAtomicWriteJson(this.pathFor(record.id), record);
      this.records.set(record.id, record);
      this.idempotency.set(record.idempotencyKey, record.id);
      return structuredClone(record);
    });
  }

  async markCommitted(operationId: string): Promise<MemoryOperationRecord> {
    return this.updateState(operationId, 'committed');
  }

  async markRecovery(operationId: string, error: string): Promise<MemoryOperationRecord> {
    return this.updateState(operationId, 'recovery', error);
  }

  async markPending(operationId: string): Promise<MemoryOperationRecord> {
    return this.updateState(operationId, 'pending');
  }

  async listOutstanding(limit = 1_000): Promise<MemoryOperationRecord[]> {
    await this.ensureInitialized();
    return [...this.records.values()]
      .filter((record) => record.state !== 'committed')
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .slice(0, Math.max(0, limit))
      .map((record) => structuredClone(record));
  }

  async get(operationId: string): Promise<MemoryOperationRecord | undefined> {
    await this.ensureInitialized();
    const record = this.records.get(operationId);
    return record ? structuredClone(record) : undefined;
  }

  private async updateState(
    operationId: string,
    state: MemoryJournalState,
    error?: string,
  ): Promise<MemoryOperationRecord> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const prior = this.records.get(operationId);
      if (!prior) throw new Error(`Memory operation not found: ${operationId}`);
      const timestamp = this.now().toISOString();
      const next = parseMemoryOperationRecord({
        ...prior,
        state,
        attempts: state === 'committed' ? prior.attempts : prior.attempts + 1,
        lastError: error,
        updatedAt: timestamp,
        committedAt: state === 'committed' ? timestamp : prior.committedAt,
      });
      assertRecordBytes(Buffer.byteLength(JSON.stringify(next), 'utf8'), this.maxRecordBytes, 'operation');
      await durableAtomicWriteJson(this.pathFor(operationId), next);
      this.records.set(operationId, next);
      if (state === 'committed') await this.pruneCommitted();
      return structuredClone(next);
    });
  }

  private pathFor(operationId: string): string {
    const digest = journalDigest(operationId);
    return join(this.rootDir, digest.slice(0, 2), `${digest}.operation.json`);
  }

  private ensureCapacity(): void {
    if (this.records.size >= this.maxTotalRecords) {
      throw new Error(`Memory operation journal reached its ${this.maxTotalRecords} record safety limit.`);
    }
  }

  private async pruneCommitted(): Promise<void> {
    const committed = [...this.records.values()]
      .filter((record) => record.state === 'committed')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    for (const record of committed.slice(this.maxCommittedRecords)) {
      await unlink(this.pathFor(record.id)).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
      this.records.delete(record.id);
      this.idempotency.delete(record.idempotencyKey);
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
      this.log?.('error', 'memory-v3: operation journal mutation failed', error);
      throw error;
    } finally {
      release();
    }
  }
}

async function collectJournalFiles(root: string, suffix: string, limit: number): Promise<string[]> {
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
      else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
      if (files.length > limit) throw new Error(`Memory journal scan exceeded the ${limit} record safety limit.`);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function quarantine(path: string, destinationDir: string, reason: string, now: () => Date): Promise<void> {
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

function journalDigest(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function assertRecordBytes(actual: number, maximum: number, kind: string): void {
  if (!Number.isInteger(maximum) || maximum <= 0) throw new Error(`Invalid ${kind} journal record limit: ${maximum}`);
  if (actual > maximum) throw new Error(`Memory ${kind} journal record exceeds the ${maximum} byte safety limit.`);
}
