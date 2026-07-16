// Persists immutable user-visible conversation sources independently from atom projections.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { durableAtomicWriteJson, sha256Canonical } from './v3/durable-json.js';

export const MEMORY_CONVERSATION_SOURCE_VERSION = 1 as const;

export type MemoryConversationSourceKind =
  | 'user-message'
  | 'assistant-reply'
  | 'tool-call'
  | 'tool-result'
  | 'task-step'
  | 'verification'
  | 'run-error';

export interface MemoryConversationSourceRecord {
  version: typeof MEMORY_CONVERSATION_SOURCE_VERSION;
  id: string;
  kind: MemoryConversationSourceKind;
  sessionId: string;
  runId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  capturedAt: string;
  contentHash: string;
}

export type MemoryConversationSourceInput = Omit<
  MemoryConversationSourceRecord,
  'version' | 'capturedAt' | 'contentHash'
>;

export interface MemoryConversationSourceStoreOptions {
  dataDir: string;
  now?: () => Date;
  maxRecordBytes?: number;
}

export interface MemoryConversationSourceManifest {
  count: number;
  contentHash: string;
}

const DEFAULT_MAX_RECORD_BYTES = 3_000_000;

export class MemoryConversationSourceConflictError extends Error {
  constructor(readonly sourceId: string) {
    super(`Conversation source ${sourceId} already exists with different content.`);
    this.name = 'MemoryConversationSourceConflictError';
  }
}

/**
 * Conversation source records are append-only. Atom merge, move, invalidation,
 * deletion and feedback never edit or remove these files.
 */
export class MemoryConversationSourceStore {
  readonly rootDir: string;
  private readonly now: () => Date;
  private readonly maxRecordBytes: number;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryConversationSourceStoreOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'conversation-sources');
    this.now = options.now ?? (() => new Date());
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  }

  async captureMany(inputs: MemoryConversationSourceInput[]): Promise<MemoryConversationSourceRecord[]> {
    const unique = new Map(inputs.map((input) => [input.id, input]));
    const records: MemoryConversationSourceRecord[] = [];
    for (const input of unique.values()) records.push(await this.capture(input));
    return records;
  }

  capture(inputValue: MemoryConversationSourceInput): Promise<MemoryConversationSourceRecord> {
    return this.exclusive(async () => {
      const input = normalizeInput(inputValue);
      const path = this.pathFor(input.id);
      if (existsSync(path)) {
        const existing = await this.readPath(path);
        if (sameSourcePayload(existing, input)) return existing;
        throw new MemoryConversationSourceConflictError(input.id);
      }
      const withoutHash: Omit<MemoryConversationSourceRecord, 'contentHash'> = {
        version: MEMORY_CONVERSATION_SOURCE_VERSION,
        ...input,
        capturedAt: this.now().toISOString(),
      };
      const record: MemoryConversationSourceRecord = {
        ...withoutHash,
        contentHash: sourceRecordContentHash(withoutHash),
      };
      assertRecordBytes(Buffer.byteLength(JSON.stringify(record), 'utf8'), this.maxRecordBytes);
      await durableAtomicWriteJson(path, record);
      return structuredClone(record);
    });
  }

  async get(sourceId: string): Promise<MemoryConversationSourceRecord | undefined> {
    const path = this.pathFor(sourceId);
    return existsSync(path) ? this.readPath(path) : undefined;
  }

  async getMany(sourceIds: string[], limit = 100): Promise<MemoryConversationSourceRecord[]> {
    const records: MemoryConversationSourceRecord[] = [];
    for (const sourceId of [...new Set(sourceIds)].slice(0, Math.max(0, Math.floor(limit)))) {
      const record = await this.get(sourceId);
      if (record) records.push(record);
    }
    return records.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  }

  async manifest(limit = 100_000): Promise<MemoryConversationSourceManifest> {
    const files = await listSourceFiles(this.rootDir, Math.max(1, Math.floor(limit)));
    const entries: Array<[string, string]> = [];
    for (const file of files) {
      const record = await this.readPath(file);
      entries.push([record.id, record.contentHash]);
    }
    entries.sort(([left], [right]) => left.localeCompare(right));
    return { count: entries.length, contentHash: sha256Canonical(entries) };
  }

  private pathFor(sourceId: string): string {
    const digest = createHash('sha256').update(sourceId, 'utf8').digest('hex');
    return join(this.rootDir, digest.slice(0, 2), `${digest}.conversation-source.json`);
  }

  private async readPath(path: string): Promise<MemoryConversationSourceRecord> {
    const bytes = await readFile(path);
    assertRecordBytes(bytes.byteLength, this.maxRecordBytes);
    const value = JSON.parse(bytes.toString('utf8')) as Partial<MemoryConversationSourceRecord>;
    if (value.version !== MEMORY_CONVERSATION_SOURCE_VERSION
      || typeof value.id !== 'string'
      || !SOURCE_KINDS.has(String(value.kind) as MemoryConversationSourceKind)
      || typeof value.sessionId !== 'string'
      || typeof value.runId !== 'string'
      || typeof value.occurredAt !== 'string'
      || typeof value.capturedAt !== 'string'
      || !isRecord(value.payload)
      || typeof value.contentHash !== 'string') {
      throw new Error('Invalid conversation source record.');
    }
    const record = value as MemoryConversationSourceRecord;
    if (!Number.isFinite(Date.parse(record.occurredAt)) || !Number.isFinite(Date.parse(record.capturedAt))) {
      throw new Error('Conversation source timestamps are invalid.');
    }
    if (sourceRecordContentHash(record) !== record.contentHash) {
      throw new Error(`Conversation source content hash mismatch: ${record.id}`);
    }
    return structuredClone(record);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const SOURCE_KINDS = new Set<MemoryConversationSourceKind>([
  'user-message',
  'assistant-reply',
  'tool-call',
  'tool-result',
  'task-step',
  'verification',
  'run-error',
]);

function normalizeInput(input: MemoryConversationSourceInput): MemoryConversationSourceInput {
  if (!input.id.trim() || !input.sessionId.trim() || !input.runId.trim()) {
    throw new Error('Conversation source requires id, sessionId and runId.');
  }
  if (!SOURCE_KINDS.has(input.kind)) throw new Error(`Unsupported conversation source kind: ${input.kind}`);
  if (!Number.isFinite(Date.parse(input.occurredAt))) throw new Error('Conversation source occurredAt is invalid.');
  if (!isRecord(input.payload)) throw new Error('Conversation source payload must be an object.');
  return {
    id: input.id.trim(),
    kind: input.kind,
    sessionId: input.sessionId.trim(),
    runId: input.runId.trim(),
    occurredAt: input.occurredAt,
    payload: structuredClone(input.payload),
  };
}

function sameSourcePayload(
  record: MemoryConversationSourceRecord,
  input: MemoryConversationSourceInput,
): boolean {
  return record.id === input.id
    && record.kind === input.kind
    && record.sessionId === input.sessionId
    && record.runId === input.runId
    && record.occurredAt === input.occurredAt
    && sha256Canonical(record.payload) === sha256Canonical(input.payload);
}

function sourceRecordContentHash(
  record: Omit<MemoryConversationSourceRecord, 'contentHash'> | MemoryConversationSourceRecord,
): string {
  const { contentHash: _ignored, ...content } = record as MemoryConversationSourceRecord;
  return sha256Canonical(content);
}

function assertRecordBytes(actual: number, maximum: number): void {
  if (!Number.isInteger(maximum) || maximum <= 0) throw new Error(`Invalid conversation source size limit: ${maximum}`);
  if (actual > maximum) throw new Error(`Conversation source exceeds the ${maximum} byte safety limit.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function listSourceFiles(rootDir: string, limit: number): Promise<string[]> {
  if (!existsSync(rootDir)) return [];
  const pending = [rootDir];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.conversation-source.json')) files.push(path);
      if (files.length > limit) throw new Error(`Conversation source scan exceeded the ${limit} file safety limit.`);
    }
  }
  return files.sort();
}
