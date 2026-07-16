// Persists append-only Memory v3 source facts separately from bounded recovery journals.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  MemoryImmutableFact,
  MemoryStorageMutation,
  MemoryUpdateEvent,
} from './contracts.js';
import { MEMORY_IMMUTABLE_FACT_VERSION } from './contracts.js';
import { durableAtomicWriteJson, sha256Canonical } from './durable-json.js';
import { parseMemoryUpdateEvent } from './validation.js';

const DEFAULT_MAX_FACT_BYTES = 3_000_000;
const DEFAULT_MAX_SCAN_FILES = 1_000_000;

export interface MemoryImmutableFactStoreOptions {
  dataDir: string;
  now?: () => Date;
  maxFactBytes?: number;
  maxScanFiles?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface MemoryImmutableFactScanResult {
  count: number;
  quarantined: number;
}

export class MemoryImmutableFactConflictError extends Error {
  constructor(readonly factId: string) {
    super(`Immutable memory fact ${factId} already exists with different content.`);
    this.name = 'MemoryImmutableFactConflictError';
  }
}

export class MemoryImmutableFactStore {
  readonly rootDir: string;
  readonly quarantineDir: string;
  private readonly now: () => Date;
  private readonly maxFactBytes: number;
  private readonly maxScanFiles: number;
  private readonly log?: MemoryImmutableFactStoreOptions['log'];
  private readonly records = new Map<string, MemoryImmutableFact>();
  private readonly idempotency = new Map<string, string>();
  private initialized = false;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryImmutableFactStoreOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'facts');
    this.quarantineDir = join(options.dataDir, 'memory-tree', 'v3', 'quarantine', 'facts');
    this.now = options.now ?? (() => new Date());
    this.maxFactBytes = options.maxFactBytes ?? DEFAULT_MAX_FACT_BYTES;
    this.maxScanFiles = options.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
    this.log = options.log;
  }

  async initialize(): Promise<MemoryImmutableFactScanResult> {
    return this.exclusive(async () => {
      await mkdir(this.rootDir, { recursive: true });
      await mkdir(this.quarantineDir, { recursive: true });
      this.records.clear();
      this.idempotency.clear();
      let quarantined = 0;
      for (const path of await collectFactFiles(this.rootDir, this.maxScanFiles)) {
        try {
          const fact = await readFact(path, this.maxFactBytes);
          if (this.records.has(fact.id) || this.idempotency.has(fact.idempotencyKey)) {
            throw new Error('duplicate fact id or idempotency key');
          }
          this.records.set(fact.id, fact);
          this.idempotency.set(fact.idempotencyKey, fact.id);
        } catch (error) {
          quarantined += 1;
          await quarantine(path, this.quarantineDir, errorMessage(error), this.now);
        }
      }
      this.initialized = true;
      return { count: this.records.size, quarantined };
    });
  }

  async capture(eventValue: MemoryUpdateEvent, mutationValue: MemoryStorageMutation): Promise<MemoryImmutableFact> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const event = parseMemoryUpdateEvent(structuredClone(eventValue));
      const mutation = cloneStorageMutation(mutationValue);
      const priorId = this.idempotency.get(event.idempotencyKey);
      const existing = this.records.get(priorId ?? event.id);
      if (existing) {
        if (sameFactPayload(existing, event, mutation)) return structuredClone(existing);
        throw new MemoryImmutableFactConflictError(existing.id);
      }
      const atomIds = mutationAtomIds(mutation);
      const factWithoutHash: Omit<MemoryImmutableFact, 'contentHash'> = {
        version: MEMORY_IMMUTABLE_FACT_VERSION,
        id: event.id,
        idempotencyKey: event.idempotencyKey,
        event,
        mutation,
        atomIds,
        capturedAt: this.now().toISOString(),
      };
      const fact: MemoryImmutableFact = {
        ...factWithoutHash,
        contentHash: immutableFactContentHash(factWithoutHash),
      };
      assertFactBytes(Buffer.byteLength(JSON.stringify(fact), 'utf8'), this.maxFactBytes);
      await durableAtomicWriteJson(this.pathFor(fact.id), fact);
      this.records.set(fact.id, fact);
      this.idempotency.set(fact.idempotencyKey, fact.id);
      return structuredClone(fact);
    });
  }

  async get(factId: string): Promise<MemoryImmutableFact | undefined> {
    await this.ensureInitialized();
    const fact = this.records.get(factId);
    return fact ? structuredClone(fact) : undefined;
  }

  async listForAtom(atomId: string, limit = 100): Promise<MemoryImmutableFact[]> {
    await this.ensureInitialized();
    return [...this.records.values()]
      .filter((fact) => fact.atomIds.includes(atomId))
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id))
      .slice(0, Math.max(0, Math.floor(limit)))
      .map((fact) => structuredClone(fact));
  }

  async *batches(batchSize = 250): AsyncGenerator<MemoryImmutableFact[]> {
    await this.ensureInitialized();
    const boundedSize = Math.max(1, Math.min(1_000, Math.floor(batchSize)));
    let batch: MemoryImmutableFact[] = [];
    for (const fact of this.records.values()) {
      batch.push(structuredClone(fact));
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

  private pathFor(factId: string): string {
    const digest = createHash('sha256').update(factId, 'utf8').digest('hex');
    return join(this.rootDir, digest.slice(0, 2), `${digest}.fact.json`);
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
      this.log?.('error', 'memory-v3: immutable fact mutation failed', error);
      throw error;
    } finally {
      release();
    }
  }
}

export function immutableFactContentHash(
  fact: Omit<MemoryImmutableFact, 'contentHash'> | MemoryImmutableFact,
): string {
  const { contentHash: _ignored, ...content } = fact as MemoryImmutableFact;
  return sha256Canonical(content);
}

function sameFactPayload(
  existing: MemoryImmutableFact,
  event: MemoryUpdateEvent,
  mutation: MemoryStorageMutation,
): boolean {
  return sha256Canonical(existing.event) === sha256Canonical(event)
    && sha256Canonical(existing.mutation) === sha256Canonical(mutation);
}

function cloneStorageMutation(value: MemoryStorageMutation): MemoryStorageMutation {
  if (!value || typeof value !== 'object') throw new Error('Memory fact requires a storage mutation.');
  const mutation = structuredClone(value);
  if (!['create', 'update', 'archive', 'restore', 'merge'].includes(mutation.kind)) {
    throw new Error(`Unsupported immutable memory fact mutation: ${String((mutation as { kind?: unknown }).kind)}`);
  }
  return mutation;
}

function mutationAtomIds(mutation: MemoryStorageMutation): string[] {
  if (mutation.kind === 'create') return [mutation.atom.id];
  if (mutation.kind === 'merge') return [...new Set([mutation.targetAtomId, mutation.sourceAtomId])];
  return [mutation.atomId];
}

async function readFact(path: string, maxBytes: number): Promise<MemoryImmutableFact> {
  const bytes = await readFile(path);
  assertFactBytes(bytes.byteLength, maxBytes);
  const value = JSON.parse(bytes.toString('utf8')) as Partial<MemoryImmutableFact>;
  if (value.version !== MEMORY_IMMUTABLE_FACT_VERSION
    || typeof value.id !== 'string'
    || typeof value.idempotencyKey !== 'string'
    || typeof value.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(value.capturedAt))
    || !Array.isArray(value.atomIds)
    || typeof value.contentHash !== 'string'
    || !value.event
    || !value.mutation) {
    throw new Error('invalid immutable memory fact');
  }
  const event = parseMemoryUpdateEvent(value.event);
  const mutation = cloneStorageMutation(value.mutation);
  const fact: MemoryImmutableFact = {
    version: MEMORY_IMMUTABLE_FACT_VERSION,
    id: value.id,
    idempotencyKey: value.idempotencyKey,
    event,
    mutation,
    atomIds: value.atomIds.map(String),
    capturedAt: value.capturedAt,
    contentHash: value.contentHash,
  };
  if (fact.id !== event.id || fact.idempotencyKey !== event.idempotencyKey) {
    throw new Error('immutable fact identity does not match its event');
  }
  if (sha256Canonical(fact.atomIds) !== sha256Canonical(mutationAtomIds(mutation))) {
    throw new Error('immutable fact atomIds do not match its mutation');
  }
  if (immutableFactContentHash(fact) !== fact.contentHash) {
    throw new Error('immutable fact content hash mismatch');
  }
  return fact;
}

async function collectFactFiles(root: string, limit: number): Promise<string[]> {
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
      else if (entry.isFile() && entry.name.endsWith('.fact.json')) files.push(path);
      if (files.length > limit) throw new Error(`Memory fact scan exceeded the ${limit} file safety limit.`);
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

function assertFactBytes(actual: number, maximum: number): void {
  if (!Number.isInteger(maximum) || maximum <= 0) throw new Error(`Invalid immutable fact size limit: ${maximum}`);
  if (actual > maximum) throw new Error(`Immutable memory fact exceeds the ${maximum} byte safety limit.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
