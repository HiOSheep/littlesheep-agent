// Durable append-only Harness event store: hashed partitions, atomic files,
// cursor/idempotency validation and fail-closed replay.
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from '@littlesheep/session';
import type {
  DurableHarnessEvent,
  DurableHarnessEventAppendInput,
  DurableHarnessEventAppendOutcome,
  DurableHarnessEventStoreLike,
} from '@littlesheep/types';
import {
  DURABLE_HARNESS_EVENT_MAX_EVENTS_PER_RUN,
  DURABLE_HARNESS_EVENT_MAX_PAYLOAD_BYTES,
  DURABLE_HARNESS_EVENT_VERSION,
} from '@littlesheep/types';
import {
  asRecord,
  boundedInteger,
  canonicalSerialize,
  hashParts,
  isAtomicWriteTempFile,
  normalizeIdentifier,
  normalizeJsonValue,
  normalizeTime,
  parseJson,
  randomId,
  writeJsonAtomically,
} from './durable-store-utils.js';
import { Buffer } from 'node:buffer';

export const DEFAULT_DURABLE_EVENT_MAX_PAYLOAD_BYTES = DURABLE_HARNESS_EVENT_MAX_PAYLOAD_BYTES;
export const DEFAULT_DURABLE_EVENT_MAX_EVENTS_PER_RUN = DURABLE_HARNESS_EVENT_MAX_EVENTS_PER_RUN;
const MAX_EVENT_ID_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const EVENT_FILE_PATTERN = /^(\d{12})-([a-f0-9]{64})\.json$/;

export interface DurableEventStoreOptions {
  /** Directory under the active LS data root. */
  rootDir: string;
  maxPayloadBytes?: number;
  maxEventsPerRun?: number;
  now?: () => Date;
}

/** A durable, append-only event stream partitioned by hashed session/run. */
export class DurableEventStore implements DurableHarnessEventStoreLike {
  private readonly rootDir: string;
  private readonly maxPayloadBytes: number;
  private readonly maxEventsPerRun: number;
  private readonly now: () => Date;
  private readonly writeTails = new Map<string, Promise<void>>();
  /**
   * Verified per-partition event cache. Every append is preceded by a full
   * partition read from the Harness kernel, so re-parsing the whole log on each
   * event made appends O(n²). The cache is only trusted after a fresh directory
   * listing proves the cached prefix is still byte-identical by filename; any
   * anomaly (gap, replacement, unknown file) falls back to the fail-closed full
   * read below.
   */
  private readonly partitionCache = new Map<string, CachedPartition>();
  private static readonly MAX_CACHED_PARTITIONS = 64;
  /**
   * Runs this process exclusively owns (next-mode `DurableRunOwnership` holds the
   * run/effect leases). Owned runs are written by one process only, so their
   * per-event cross-process lock is redundant; in-process ordering still comes
   * from `writeTails`. Untrusted runs keep the lock exactly as before.
   */
  private readonly trustedRuns = new Map<string, string>();
  private static readonly MAX_TRUSTED_RUNS = 256;
  private initialized = false;
  private initializationFailure: Error | undefined;

  constructor(options: DurableEventStoreOptions) {
    const root = options.rootDir.trim();
    if (!root) throw new Error('durable event store rootDir must be non-empty');
    this.rootDir = root;
    this.maxPayloadBytes = boundedInteger(
      options.maxPayloadBytes,
      DEFAULT_DURABLE_EVENT_MAX_PAYLOAD_BYTES,
      1_024,
      4 * 1024 * 1024,
    );
    this.maxEventsPerRun = boundedInteger(
      options.maxEventsPerRun,
      DEFAULT_DURABLE_EVENT_MAX_EVENTS_PER_RUN,
      1,
      100_000,
    );
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializationFailure) throw this.initializationFailure;
    try {
      await mkdir(this.rootDir, { recursive: true });
      // Historical partition validation belongs to the recovery scan. Even a
      // directory-only listing of a large Windows data root can delay unrelated
      // new runs by seconds. Reads and appends still validate their own partition.
      this.initialized = true;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.initializationFailure = normalized;
      throw normalized;
    }
  }

  /** Startup state is intentionally observable so strict callers cannot
   * mistake a failed scan for a store that merely happens to append later. */
  get initializationError(): Error | undefined {
    return this.initializationFailure;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  async append<TPayload extends Record<string, unknown>>(
    input: DurableHarnessEventAppendInput<TPayload>,
  ): Promise<DurableHarnessEventAppendOutcome<TPayload>> {
    const generatedOccurredAt = input.occurredAt === undefined;
    const normalized = validateAppendInput(
      generatedOccurredAt ? { ...input, occurredAt: this.now().toISOString() } : input,
      this.maxPayloadBytes,
    );
    const partition = this.partitionPath(normalized.sessionId, normalized.runId);
    const previous = this.writeTails.get(partition) ?? Promise.resolve();
    const operation: Promise<DurableHarnessEventAppendOutcome<TPayload>> = previous.catch(() => undefined).then(async () => {
      await mkdir(partition, { recursive: true });
      const trusted = this.trustedRuns.get(normalized.runId) === partition;
      const lock = trusted ? undefined : await acquireLock(join(partition, '.events'), 60_000);
      try {
        const existing = await this.readPartitionCached(partition, normalized.sessionId, normalized.runId);
        const byEventId = normalized.eventId
          ? existing.find((event) => event.eventId === normalized.eventId)
          : undefined;
        if (byEventId) {
          return sameEventInput(byEventId, normalized, generatedOccurredAt)
            ? { kind: 'duplicate' as const, event: cloneEvent(byEventId) as DurableHarnessEvent<TPayload> }
            : { kind: 'conflict' as const, key: 'eventId' as const, existing: cloneEvent(byEventId) };
        }
        const byIdempotency = existing.find((event) => event.idempotencyKey === normalized.idempotencyKey);
        if (byIdempotency) {
          return sameEventInput(byIdempotency, normalized, generatedOccurredAt)
            ? { kind: 'duplicate' as const, event: cloneEvent(byIdempotency) as DurableHarnessEvent<TPayload> }
            : { kind: 'conflict' as const, key: 'idempotencyKey' as const, existing: cloneEvent(byIdempotency) };
        }
        if (normalized.expectedCursor !== undefined && existing.length !== normalized.expectedCursor) {
          throw new DurableEventStoreError(
            `event cursor changed during append: expected ${normalized.expectedCursor}, found ${existing.length}`,
            'conflict',
          );
        }
        if (existing.length >= this.maxEventsPerRun) {
          throw new DurableEventStoreError(`event stream exceeds ${this.maxEventsPerRun} events`, 'limit');
        }
        const cursor = (existing.at(-1)?.cursor ?? 0) + 1;
        const event: DurableHarnessEvent<TPayload> = {
          version: DURABLE_HARNESS_EVENT_VERSION,
          eventId: normalized.eventId ?? randomId(),
          idempotencyKey: normalized.idempotencyKey,
          sessionId: normalized.sessionId,
          runId: normalized.runId,
          cursor,
          type: normalized.type,
          source: normalized.source,
          occurredAt: normalized.occurredAt,
          payload: normalized.payload as TPayload,
        };
        await writeEventFile(partition, event);
        const current = this.partitionCache.get(partition);
        const stamps = current?.stamps ?? [];
        const written = await statEventFile(partition, eventFileName(event));
        if (written && stamps.length === existing.length) {
          this.rememberPartition(partition, [...existing, event], [...stamps, written]);
        } else {
          this.partitionCache.delete(partition);
        }
        return { kind: 'appended' as const, event: cloneEvent(event) };
      } finally {
        await lock?.release();
      }
    });
    this.writeTails.set(partition, operation.then(() => undefined, () => undefined));
    return operation;
  }

  /** Trust this process as the exclusive writer of a run it has leased. */
  trustExclusiveRunOwnership(sessionId: string, runId: string): void {
    const normalizedSession = normalizeIdentifier(sessionId, 'sessionId');
    const normalizedRun = normalizeIdentifier(runId, 'runId');
    if (!this.trustedRuns.has(normalizedRun) && this.trustedRuns.size >= DurableEventStore.MAX_TRUSTED_RUNS) {
      const oldest = this.trustedRuns.keys().next().value;
      if (oldest !== undefined) this.trustedRuns.delete(oldest);
    }
    this.trustedRuns.set(normalizedRun, this.partitionPath(normalizedSession, normalizedRun));
  }

  releaseExclusiveRunOwnership(runId: string): void {
    this.trustedRuns.delete(runId);
  }

  async read(sessionId: string, runId: string): Promise<DurableHarnessEvent[]> {
    const normalizedSessionId = normalizeIdentifier(sessionId, 'sessionId');
    const normalizedRunId = normalizeIdentifier(runId, 'runId');
    return (await this.readPartitionCached(
      this.partitionPath(normalizedSessionId, normalizedRunId),
      normalizedSessionId,
      normalizedRunId,
    )).map(cloneEvent);
  }

  async readAfter(sessionId: string, runId: string, cursor: number): Promise<DurableHarnessEvent[]> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative integer');
    return (await this.read(sessionId, runId)).filter((event) => event.cursor > cursor);
  }

  /**
   * Enumerate durable run identities for startup recovery. This returns only
   * identifiers; callers must replay each partition before taking action.
   * Corrupt partitions fail closed instead of being silently skipped.
   */
  async listRuns(): Promise<Array<{ sessionId: string; runId: string }>> {
    await this.initialize();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const runs: Array<{ sessionId: string; runId: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^[a-f0-9]{64}$/.test(entry.name)) throw new DurableEventStoreError(`invalid event partition: ${entry.name}`, 'corrupt');
      const events = await this.readPartition(join(this.rootDir, entry.name));
      const first = events[0];
      if (first) runs.push({ sessionId: first.sessionId, runId: first.runId });
    }
    return runs.sort((left, right) => (
      left.sessionId.localeCompare(right.sessionId) || left.runId.localeCompare(right.runId)
    ));
  }

  private partitionPath(sessionId: string, runId: string): string {
    return join(this.rootDir, hashParts(sessionId, runId));
  }

  /**
   * Incrementally verified partition read. A fresh directory listing must prove
   * the cached events still occupy the same filenames; then only the new tail
   * files are parsed. Anything else re-reads the whole partition fail-closed.
   */
  private async readPartitionCached(
    partition: string,
    expectedSessionId?: string,
    expectedRunId?: string,
  ): Promise<DurableHarnessEvent[]> {
    const files = await this.listPartitionEventFiles(partition);
    const cached = this.partitionCache.get(partition);
    if (cached && files.length >= cached.events.length
      && cached.events.every((event, index) => files[index] === eventFileName(event))
      && await cachedStampsMatch(partition, files, cached.stamps)) {
      const grown = cached.events.slice();
      const stamps = cached.stamps.slice();
      for (let index = cached.events.length; index < files.length; index += 1) {
        const fileName = files[index]!;
        grown.push(await this.readEventFile(partition, fileName, expectedSessionId, expectedRunId));
        const stamp = await statEventFile(partition, fileName);
        if (!stamp) break;
        stamps.push(stamp);
      }
      if (grown.length === files.length && stamps.length === grown.length) {
        assertPartitionIntegrity(grown, this.maxEventsPerRun);
        this.rememberPartition(partition, grown, stamps);
        return grown;
      }
    }
    const events = await this.readPartitionFull(partition, files, expectedSessionId, expectedRunId);
    const stamps: FileStamp[] = [];
    for (const file of files) {
      const stamp = await statEventFile(partition, file);
      if (!stamp) {
        this.partitionCache.delete(partition);
        return events;
      }
      stamps.push(stamp);
    }
    this.rememberPartition(partition, events, stamps);
    return events;
  }

  private async readPartitionFull(
    partition: string,
    files: string[],
    expectedSessionId?: string,
    expectedRunId?: string,
  ): Promise<DurableHarnessEvent[]> {
    const events: DurableHarnessEvent[] = [];
    for (const file of files) {
      events.push(await this.readEventFile(partition, file, expectedSessionId, expectedRunId));
    }
    assertPartitionIntegrity(events, this.maxEventsPerRun);
    return events;
  }

  private async readPartition(partition: string, expectedSessionId?: string, expectedRunId?: string): Promise<DurableHarnessEvent[]> {
    return this.readPartitionFull(
      partition,
      await this.listPartitionEventFiles(partition),
      expectedSessionId,
      expectedRunId,
    );
  }

  /** Directory listing with the event store's fail-closed filename rules. */
  private async listPartitionEventFiles(partition: string): Promise<string[]> {
    const entries = await readdir(partition, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // A concurrent process may be mid-rename for a committed event. Its
      // temp file is not part of the append-only log, so ignore it instead of
      // failing closed on a live write. A crash-orphaned temp is likewise
      // non-authoritative; the final JSON file is the only readable record.
      if (isAtomicWriteTempFile(entry.name)) continue;
      if (!entry.name.endsWith('.json') && entry.name !== '.events.lock') {
        throw new DurableEventStoreError(`unexpected event store file: ${entry.name}`, 'corrupt');
      }
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async readEventFile(
    partition: string,
    fileName: string,
    expectedSessionId?: string,
    expectedRunId?: string,
  ): Promise<DurableHarnessEvent> {
    const match = EVENT_FILE_PATTERN.exec(fileName);
    if (!match) throw new DurableEventStoreError(`invalid event filename: ${fileName}`, 'corrupt');
    const cursorFromName = Number(match[1]);
    const event = validateStoredEvent(
      parseJson(await readFile(join(partition, fileName), 'utf8'), join(partition, fileName)),
      this.maxPayloadBytes,
    );
    if (event.cursor !== cursorFromName) throw new DurableEventStoreError(`event cursor/file mismatch: ${fileName}`, 'corrupt');
    if (hashParts(event.eventId) !== match[2]) throw new DurableEventStoreError(`event id/file mismatch: ${fileName}`, 'corrupt');
    const partitionName = partition.split(/[\\/]/).at(-1);
    if (partitionName && hashParts(event.sessionId, event.runId) !== partitionName) {
      throw new DurableEventStoreError(`event partition mismatch: ${fileName}`, 'corrupt');
    }
    if (expectedSessionId !== undefined && (event.sessionId !== expectedSessionId || event.runId !== expectedRunId)) {
      throw new DurableEventStoreError(`event session/run mismatch: ${fileName}`, 'corrupt');
    }
    return event;
  }

  private rememberPartition(partition: string, events: DurableHarnessEvent[], stamps: FileStamp[]): void {
    if (!this.partitionCache.has(partition)
      && this.partitionCache.size >= DurableEventStore.MAX_CACHED_PARTITIONS) {
      const oldest = this.partitionCache.keys().next().value;
      if (oldest !== undefined) this.partitionCache.delete(oldest);
    }
    this.partitionCache.set(partition, { events, stamps });
  }

}

export class DurableEventStoreError extends Error {
  constructor(message: string, readonly kind: 'corrupt' | 'limit' | 'invalid' | 'conflict') {
    super(message);
    this.name = 'DurableEventStoreError';
  }
}

async function writeEventFile(partition: string, event: DurableHarnessEvent): Promise<void> {
  const file = join(partition, eventFileName(event));
  await writeJsonAtomically(file, event);
}

function eventFileName(event: DurableHarnessEvent): string {
  return `${String(event.cursor).padStart(12, '0')}-${hashParts(event.eventId)}.json`;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}

interface CachedPartition {
  events: DurableHarnessEvent[];
  stamps: FileStamp[];
}

async function statEventFile(partition: string, fileName: string): Promise<FileStamp | undefined> {
  try {
    const details = await stat(join(partition, fileName));
    return { size: details.size, mtimeMs: details.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * The cached prefix is only trusted while every file still carries the size and
 * mtime we read. A same-name rewrite (corruption or tampering) is therefore
 * caught and forced through the full fail-closed read.
 */
async function cachedStampsMatch(partition: string, files: string[], stamps: FileStamp[]): Promise<boolean> {
  // Stats are independent; running them in parallel keeps the per-append
  // verification cheap even when the cached prefix is long.
  const matches = await Promise.all(stamps.map(async (cached, index) => {
    const current = await statEventFile(partition, files[index]!);
    return Boolean(cached && current && current.size === cached.size && current.mtimeMs === cached.mtimeMs);
  }));
  return matches.every(Boolean);
}

/** Shared fail-closed invariants for a fully or incrementally read partition. */
function assertPartitionIntegrity(events: DurableHarnessEvent[], maxEventsPerRun: number): void {
  const cursors = new Set<number>();
  const eventIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || event.cursor !== index + 1) {
      throw new DurableEventStoreError('event cursors must be contiguous and start at 1', 'corrupt');
    }
    if (cursors.has(event.cursor)) throw new DurableEventStoreError(`duplicate event cursor: ${event.cursor}`, 'corrupt');
    if (eventIds.has(event.eventId)) throw new DurableEventStoreError(`duplicate event id: ${event.eventId}`, 'corrupt');
    if (idempotencyKeys.has(event.idempotencyKey)) {
      throw new DurableEventStoreError(`duplicate idempotency key: ${event.idempotencyKey}`, 'corrupt');
    }
    cursors.add(event.cursor);
    eventIds.add(event.eventId);
    idempotencyKeys.add(event.idempotencyKey);
  }
  if (events.length > maxEventsPerRun) throw new DurableEventStoreError('event stream exceeds configured limit', 'limit');
}

function validateAppendInput<TPayload extends Record<string, unknown>>(
  input: DurableHarnessEventAppendInput<TPayload>,
  maxPayloadBytes: number,
  ): DurableHarnessEventAppendInput<TPayload> & { eventId?: string; occurredAt: string; payload: TPayload } {
  const eventId = input.eventId === undefined ? undefined : normalizeBoundedString(input.eventId, 'eventId', MAX_EVENT_ID_LENGTH);
  const idempotencyKey = normalizeBoundedString(input.idempotencyKey, 'idempotencyKey', MAX_IDEMPOTENCY_KEY_LENGTH);
  const sessionId = normalizeIdentifier(input.sessionId, 'sessionId');
  const runId = normalizeIdentifier(input.runId, 'runId');
  const occurredAt = normalizeTime(input.occurredAt ?? new Date().toISOString(), 'occurredAt');
  if (input.expectedCursor !== undefined
    && (!Number.isSafeInteger(input.expectedCursor) || input.expectedCursor < 0)) {
    throw new Error('expectedCursor must be a non-negative integer');
  }
  const payload = normalizeJsonValue(input.payload, 'payload');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
  const serialized = canonicalSerialize(payload);
  if (Buffer.byteLength(serialized, 'utf8') > maxPayloadBytes) throw new Error(`payload exceeds ${maxPayloadBytes} bytes`);
  if (!isEventType(input.type)) throw new Error(`unknown durable event type: ${String(input.type)}`);
  if (!isEventSource(input.source)) throw new Error(`unknown durable event source: ${String(input.source)}`);
  return { ...input, eventId, idempotencyKey, sessionId, runId, occurredAt, payload: payload as TPayload };
}

function validateStoredEvent(value: unknown, maxPayloadBytes: number): DurableHarnessEvent {
  const record = asRecord(value, 'event');
  if (record.version !== DURABLE_HARNESS_EVENT_VERSION) throw new DurableEventStoreError(`unknown event version: ${String(record.version)}`, 'corrupt');
  if (!Number.isSafeInteger(record.cursor) || (record.cursor as number) < 1) throw new DurableEventStoreError('invalid event cursor', 'corrupt');
  const input = validateAppendInput({
    eventId: record.eventId as string,
    idempotencyKey: record.idempotencyKey as string,
    sessionId: record.sessionId as string,
    runId: record.runId as string,
    type: record.type as DurableHarnessEvent['type'],
    source: record.source as DurableHarnessEvent['source'],
    occurredAt: record.occurredAt as string,
    payload: record.payload as Record<string, unknown>,
  }, maxPayloadBytes);
  return {
    version: DURABLE_HARNESS_EVENT_VERSION,
    eventId: input.eventId ?? '',
    idempotencyKey: input.idempotencyKey,
    sessionId: input.sessionId,
    runId: input.runId,
    cursor: record.cursor as number,
    type: input.type,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: input.payload,
  };
}

function normalizeBoundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must be 1-${max} characters`);
  return normalized;
}

function sameEventInput(event: DurableHarnessEvent, input: DurableHarnessEventAppendInput, allowOccurredAtDifference = false): boolean {
  return event.idempotencyKey === input.idempotencyKey
    && event.sessionId === input.sessionId
    && event.runId === input.runId
    && event.type === input.type
    && event.source === input.source
    && (allowOccurredAtDifference || event.occurredAt === input.occurredAt)
    && canonicalSerialize(event.payload) === canonicalSerialize(input.payload);
}

function cloneEvent<T extends DurableHarnessEvent>(event: T): T {
  return JSON.parse(JSON.stringify(event)) as T;
}

function isEventType(value: unknown): value is DurableHarnessEvent['type'] {
  return value === 'run_accepted'
    || value === 'user_input_appended'
    || value === 'capability_snapshot_read'
    || value === 'capability_probe_settled'
    || value === 'stage_transition_recorded'
    || value === 'route_decided'
    || value === 'model_request_started'
    || value === 'model_response_received'
    || value === 'model_request_settled'
    || value === 'tool_call_proposed'
    || value === 'effect_intent_created'
    || value === 'effect_settled'
    || value === 'verification_recorded'
    || value === 'checkpoint_written'
    || value === 'final_reply_proposed'
    || value === 'final_reply_settled'
    || value === 'runtime_status_settled'
    || value === 'run_failed'
    || value === 'run_interrupted'
    || value === 'run_completed';
}

function isEventSource(value: unknown): value is DurableHarnessEvent['source'] {
  return value === 'runtime' || value === 'model' || value === 'tool' || value === 'app' || value === 'channel' || value === 'system';
}
