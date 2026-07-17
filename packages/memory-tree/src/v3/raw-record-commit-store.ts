// Persists append-only proof that projection mutations reached the commit boundary.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MemoryRawRecord, MemoryRawRecordCommitReceipt } from './contracts.js';
import { MEMORY_RAW_RECORD_COMMIT_VERSION } from './contracts.js';
import { durableAtomicWriteJson, sha256Canonical } from './durable-json.js';

export interface MemoryRawRecordCommitStoreOptions {
  dataDir: string;
  now: () => Date;
  maxReceiptBytes: number;
  maxScanFiles: number;
  resolveRawRecord: (rawRecordId: string) => Promise<MemoryRawRecord | undefined>;
}

export class MemoryRawRecordCommitConflictError extends Error {
  constructor(readonly rawRecordId: string) {
    super(`Memory raw record ${rawRecordId} already has a different commit receipt.`);
    this.name = 'MemoryRawRecordCommitConflictError';
  }
}

export class MemoryRawRecordCommitStore {
  readonly rootDir: string;
  readonly quarantineDir: string;
  private readonly now: () => Date;
  private readonly maxReceiptBytes: number;
  private readonly maxScanFiles: number;
  private readonly resolveRawRecord: (rawRecordId: string) => Promise<MemoryRawRecord | undefined>;
  private initialized = false;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryRawRecordCommitStoreOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'raw-record-commits');
    this.quarantineDir = join(options.dataDir, 'memory-tree', 'v3', 'quarantine', 'raw-record-commits');
    this.now = options.now;
    this.maxReceiptBytes = options.maxReceiptBytes;
    this.maxScanFiles = options.maxScanFiles;
    this.resolveRawRecord = options.resolveRawRecord;
  }

  async initialize(): Promise<void> {
    await this.exclusive(async () => {
      await Promise.all([
        mkdir(this.rootDir, { recursive: true }),
        mkdir(this.quarantineDir, { recursive: true }),
      ]);
      for (const path of await collectReceiptFiles(this.rootDir, this.maxScanFiles)) {
        try {
          const receipt = await readReceipt(path, this.maxReceiptBytes);
          const record = await this.resolveRawRecord(receipt.rawRecordId);
          if (!record) throw new Error('commit receipt references a missing raw record');
          if (record.contentHash !== receipt.rawRecordContentHash) {
            throw new Error('commit receipt record hash does not match the raw record');
          }
        } catch (error) {
          await quarantine(path, this.quarantineDir, errorMessage(error), this.now);
        }
      }
      this.initialized = true;
    });
  }

  async markCommitted(rawRecordId: string, operationId: string): Promise<MemoryRawRecordCommitReceipt> {
    await this.ensureInitialized();
    return this.exclusive(async () => {
      const record = await this.resolveRawRecord(rawRecordId);
      if (!record) throw new Error(`Memory raw record not found: ${rawRecordId}`);
      const existing = await this.readDirect(rawRecordId);
      if (existing) {
        if (existing.rawRecordContentHash === record.contentHash && existing.operationId === operationId) {
          return existing;
        }
        throw new MemoryRawRecordCommitConflictError(rawRecordId);
      }
      const receiptWithoutHash: Omit<MemoryRawRecordCommitReceipt, 'contentHash'> = {
        version: MEMORY_RAW_RECORD_COMMIT_VERSION,
        rawRecordId,
        rawRecordContentHash: record.contentHash,
        operationId,
        committedAt: this.now().toISOString(),
      };
      const receipt: MemoryRawRecordCommitReceipt = {
        ...receiptWithoutHash,
        contentHash: rawRecordCommitReceiptContentHash(receiptWithoutHash),
      };
      assertReceiptBytes(Buffer.byteLength(JSON.stringify(receipt), 'utf8'), this.maxReceiptBytes);
      await durableAtomicWriteJson(this.pathFor(rawRecordId), receipt);
      return structuredClone(receipt);
    });
  }

  async get(rawRecordId: string): Promise<MemoryRawRecordCommitReceipt | undefined> {
    await this.ensureInitialized();
    return this.readDirect(rawRecordId);
  }

  private async readDirect(rawRecordId: string): Promise<MemoryRawRecordCommitReceipt | undefined> {
    const path = this.pathFor(rawRecordId);
    return existsSync(path) ? readReceipt(path, this.maxReceiptBytes) : undefined;
  }

  private pathFor(rawRecordId: string): string {
    const digest = createHash('sha256').update(rawRecordId, 'utf8').digest('hex');
    return join(this.rootDir, digest.slice(0, 2), `${digest}.commit.json`);
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
    } finally {
      release();
    }
  }
}

export function rawRecordCommitReceiptContentHash(
  receipt: Omit<MemoryRawRecordCommitReceipt, 'contentHash'> | MemoryRawRecordCommitReceipt,
): string {
  const { contentHash: _ignored, ...content } = receipt as MemoryRawRecordCommitReceipt;
  return sha256Canonical(content);
}

async function readReceipt(path: string, maxBytes: number): Promise<MemoryRawRecordCommitReceipt> {
  const bytes = await readFile(path);
  assertReceiptBytes(bytes.byteLength, maxBytes);
  const value = JSON.parse(bytes.toString('utf8')) as Partial<MemoryRawRecordCommitReceipt>;
  if (value.version !== MEMORY_RAW_RECORD_COMMIT_VERSION
    || typeof value.rawRecordId !== 'string'
    || typeof value.rawRecordContentHash !== 'string'
    || typeof value.operationId !== 'string'
    || typeof value.committedAt !== 'string'
    || typeof value.contentHash !== 'string') {
    throw new Error('invalid raw record commit receipt');
  }
  const receipt = value as MemoryRawRecordCommitReceipt;
  if (rawRecordCommitReceiptContentHash(receipt) !== receipt.contentHash) {
    throw new Error('raw record commit receipt content hash mismatch');
  }
  return receipt;
}

async function collectReceiptFiles(root: string, limit: number): Promise<string[]> {
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
      else if (entry.isFile() && entry.name.endsWith('.commit.json')) files.push(path);
      if (files.length > limit) throw new Error(`Memory raw record commit scan exceeded the ${limit} file safety limit.`);
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

function assertReceiptBytes(actual: number, maximum: number): void {
  if (!Number.isInteger(maximum) || maximum <= 0) throw new Error(`Invalid raw record commit size limit: ${maximum}`);
  if (actual > maximum) throw new Error(`Memory raw record commit exceeds the ${maximum} byte safety limit.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
