// Persists immutable user-visible conversation sources independently from atom projections.

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
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

/** Resumable position of a session's first backfill. */
export interface MemoryConversationSourceWatermark {
  version: 1;
  sessionId: string;
  watermark: string;
  updatedAt: string;
}

export interface MemoryConversationSourceBackfillInput {
  sessionId: string;
  /** Last source id already backfilled (exclusive); defaults to the persisted watermark. */
  since?: string;
  /** Ordered session sources to capture; ids at or before the watermark are skipped. */
  sources: MemoryConversationSourceInput[];
}

export interface MemoryConversationSourceBackfillResult {
  captured: MemoryConversationSourceRecord[];
  watermark?: string;
  resumed: boolean;
}

export interface MemoryConversationSourceStoreOptions {
  dataDir: string;
  now?: () => Date;
  maxRecordBytes?: number;
  /** Upper bound on source files inspected by a single catalog page request. */
  catalogScanLimit?: number;
}

export interface MemoryConversationSourceManifest {
  count: number;
  contentHash: string;
}

/** A bounded directory entry. Payload bodies are only returned by `getMany` expansion. */
export interface MemoryConversationSourceCatalogEntry {
  id: string;
  kind: MemoryConversationSourceKind;
  sessionId: string;
  runId: string;
  occurredAt: string;
  capturedAt: string;
}

export interface MemoryConversationSourceCatalogQuery {
  /** Exactly one of sessionId/runId is required so callers locate a scope before expanding. */
  sessionId?: string;
  runId?: string;
  kind?: MemoryConversationSourceKind;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export type MemoryConversationSourceCatalogStatus = 'ok' | 'degraded' | 'unsupported';

export interface MemoryConversationSourceCatalogPage {
  status: MemoryConversationSourceCatalogStatus;
  reason?: string;
  entries: MemoryConversationSourceCatalogEntry[];
  nextCursor?: string;
  scanned: number;
}

const DEFAULT_MAX_RECORD_BYTES = 3_000_000;
const DEFAULT_CATALOG_SCAN_LIMIT = 20_000;
const DEFAULT_CATALOG_PAGE_SIZE = 50;
const MAX_CATALOG_PAGE_SIZE = 200;
const MAX_KNOWN_SOURCES = 512;

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
  private readonly catalogScanLimit: number;
  private readonly knownSources = new Map<string, { record: MemoryConversationSourceRecord; size: number; mtimeMs: number }>();
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryConversationSourceStoreOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3', 'conversation-sources');
    this.now = options.now ?? (() => new Date());
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.catalogScanLimit = options.catalogScanLimit ?? DEFAULT_CATALOG_SCAN_LIMIT;
    if (!Number.isInteger(this.catalogScanLimit) || this.catalogScanLimit <= 0) {
      throw new Error(`Invalid conversation source catalog scan limit: ${this.catalogScanLimit}`);
    }
  }

  async captureMany(inputs: MemoryConversationSourceInput[]): Promise<MemoryConversationSourceRecord[]> {
    const unique = new Map(inputs.map((input) => [input.id, input]));
    const records: MemoryConversationSourceRecord[] = [];
    for (const input of unique.values()) records.push(await this.capture(input));
    return records;
  }

  capture(inputValue: MemoryConversationSourceInput): Promise<MemoryConversationSourceRecord> {
    return this.exclusive(() => this.captureLocked(inputValue));
  }

  async readBackfillWatermark(sessionId: string): Promise<MemoryConversationSourceWatermark | undefined> {
    const normalized = sessionId.trim();
    if (!normalized) return undefined;
    const path = this.backfillPathFor(normalized);
    if (!existsSync(path)) return undefined;
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<MemoryConversationSourceWatermark>;
      if (value.version !== 1 || value.sessionId !== normalized || typeof value.watermark !== 'string') return undefined;
      return {
        version: 1,
        sessionId: normalized,
        watermark: value.watermark,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
      };
    } catch {
      return undefined;
    }
  }

  /**
   * HC-02 first backfill: capture only sources after the persisted watermark and
   * advance it in the same exclusive section, so an interrupted backfill resumes
   * instead of re-walking (or re-embedding) the whole session history.
   */
  async backfill(input: MemoryConversationSourceBackfillInput): Promise<MemoryConversationSourceBackfillResult> {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) throw new Error('Conversation source backfill requires a sessionId.');
    return this.exclusive(async () => {
      const persisted = await this.readBackfillWatermark(sessionId);
      const since = input.since?.trim() || persisted?.watermark;
      const scoped = input.sources.filter((source) => source.sessionId.trim() === sessionId);
      const startIndex = since ? scoped.findIndex((source) => source.id.trim() === since) : -1;
      const pending = startIndex >= 0 ? scoped.slice(startIndex + 1) : scoped;
      const captured: MemoryConversationSourceRecord[] = [];
      for (const source of pending) captured.push(await this.captureLocked(source));
      const watermark = captured.at(-1)?.id ?? since;
      if (watermark && watermark !== persisted?.watermark) {
        await durableAtomicWriteJson(this.backfillPathFor(sessionId), {
          version: 1,
          sessionId,
          watermark,
          updatedAt: this.now().toISOString(),
        } satisfies MemoryConversationSourceWatermark);
      }
      return { captured, watermark, resumed: Boolean(since) };
    });
  }

  private async captureLocked(inputValue: MemoryConversationSourceInput): Promise<MemoryConversationSourceRecord> {
    const input = normalizeInput(inputValue);
    const path = this.pathFor(input.id);
    // Records are append-only: a source already captured by this process can be
    // answered from memory once its file still matches the recorded stamp.
    const known = this.knownSources.get(input.id);
    if (known) {
      const stamp = await sourceFileStamp(path);
      if (stamp && stamp.size === known.size && stamp.mtimeMs === known.mtimeMs) {
        if (sameSourcePayload(known.record, input)) return structuredClone(known.record);
        throw new MemoryConversationSourceConflictError(input.id);
      }
    }
    if (existsSync(path)) {
      const existing = await this.readPath(path);
      await this.rememberSource(input.id, path, existing);
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
    await this.rememberSource(input.id, path, record);
    return structuredClone(record);
  }

  private async rememberSource(
    sourceId: string,
    path: string,
    record: MemoryConversationSourceRecord,
  ): Promise<void> {
    const stamp = await sourceFileStamp(path);
    if (!stamp) {
      this.knownSources.delete(sourceId);
      return;
    }
    if (!this.knownSources.has(sourceId) && this.knownSources.size >= MAX_KNOWN_SOURCES) {
      const oldest = this.knownSources.keys().next().value;
      if (oldest !== undefined) this.knownSources.delete(oldest);
    }
    this.knownSources.set(sourceId, { record, size: stamp.size, mtimeMs: stamp.mtimeMs });
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

  /**
   * Bounded session/run directory: callers must name a scope, then expand ids
   * with `getMany`. Unreadable files and scan-budget exhaustion degrade the
   * page instead of silently pretending the missing sources do not exist.
   */
  async catalog(query: MemoryConversationSourceCatalogQuery = {}): Promise<MemoryConversationSourceCatalogPage> {
    const sessionId = query.sessionId?.trim();
    const runId = query.runId?.trim();
    if (!sessionId && !runId) {
      throw new Error('Conversation source catalog requires a sessionId or runId scope.');
    }
    const limit = clampPageSize(query.limit);
    const cursor = query.cursor?.trim();
    const collected = await collectSourceFiles(this.rootDir, this.catalogScanLimit);
    const entries: MemoryConversationSourceCatalogEntry[] = [];
    let unreadable = 0;
    let scanned = 0;
    let cancelled = false;
    for (const file of collected.files) {
      if (query.signal?.aborted) {
        cancelled = true;
        break;
      }
      scanned += 1;
      let record: MemoryConversationSourceRecord;
      try {
        record = await this.readPath(file);
      } catch {
        unreadable += 1;
        continue;
      }
      if (sessionId && record.sessionId !== sessionId) continue;
      if (runId && record.runId !== runId) continue;
      if (query.kind && record.kind !== query.kind) continue;
      entries.push(catalogEntryOf(record));
    }
    entries.sort((left, right) => (
      left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)
    ));
    const cursorIndex = cursor ? entries.findIndex((entry) => entry.id === cursor) : -1;
    const offset = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    const page = entries.slice(offset, offset + limit);
    const nextCursor = offset + limit < entries.length ? page.at(-1)?.id : undefined;
    const reason = cancelled
      ? 'catalog-cancelled'
      : collected.truncated
        ? 'catalog-scan-limit-reached'
        : unreadable > 0
          ? `unreadable-sources:${unreadable}`
          : undefined;
    return {
      status: reason ? 'degraded' : 'ok',
      ...(reason ? { reason } : {}),
      entries: page,
      ...(nextCursor ? { nextCursor } : {}),
      scanned,
    };
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

  private backfillPathFor(sessionId: string): string {
    const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex');
    return join(this.rootDir, '_backfill', `${digest}.json`);
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

async function sourceFileStamp(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const details = await stat(path);
    return { size: details.size, mtimeMs: details.mtimeMs };
  } catch {
    return undefined;
  }
}

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

function catalogEntryOf(record: MemoryConversationSourceRecord): MemoryConversationSourceCatalogEntry {
  return {
    id: record.id,
    kind: record.kind,
    sessionId: record.sessionId,
    runId: record.runId,
    occurredAt: record.occurredAt,
    capturedAt: record.capturedAt,
  };
}

function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_CATALOG_PAGE_SIZE;
  return Math.min(MAX_CATALOG_PAGE_SIZE, Math.floor(value));
}

async function listSourceFiles(rootDir: string, limit: number): Promise<string[]> {
  const collected = await collectSourceFiles(rootDir, limit);
  if (collected.truncated) throw new Error(`Conversation source scan exceeded the ${limit} file safety limit.`);
  return collected.files;
}

async function collectSourceFiles(
  rootDir: string,
  cap: number,
): Promise<{ files: string[]; truncated: boolean }> {
  if (!existsSync(rootDir)) return { files: [], truncated: false };
  const pending = [rootDir];
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.conversation-source.json')) continue;
      if (files.length >= cap) return { files: files.sort(), truncated: true };
      files.push(path);
    }
  }
  return { files: files.sort(), truncated: false };
}
