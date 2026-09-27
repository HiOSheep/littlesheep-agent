// Durable Harness command inbox: leased claims, restart recovery and
// idempotent completion without owning tool or model execution.
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import type {
  DurableInboxClaimFilter,
  DurableInboxCommand,
  DurableInboxEnqueueInput,
  DurableInboxEnqueueOutcome,
  DurableInboxStoreLike,
} from '@littlesheep/types';
import { DURABLE_HARNESS_EVENT_MAX_PAYLOAD_BYTES, DURABLE_HARNESS_INBOX_VERSION } from '@littlesheep/types';
import {
  asRecord,
  boundedInteger,
  canonicalSerialize,
  hashParts,
  isAtomicWriteTempFile,
  normalizeIdentifier,
  normalizeJsonValue,
  normalizeReason,
  normalizeTime,
  parseJson,
  randomId,
  writeJsonAtomically,
} from './durable-store-utils.js';
import {
  readInboxCommands,
  rememberInboxCommand,
  statInboxFile,
  type InboxCommandState,
} from './durable-inbox-cache.js';
import { matchesClaimFilter, normalizeClaimFilter } from './durable-inbox-claim-filter.js';
import { InboxWriteLock } from './durable-inbox-lock.js';

const COMMAND_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const MAX_COMMAND_ID_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_CLAIM_TOKEN_LENGTH = 256;
const MAX_RESULT_EVENT_IDS = 128;
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const MAX_LEASE_MS = 60 * 60 * 1_000;
const DEFAULT_CLAIM_LIMIT = 16;
const MAX_CLAIM_LIMIT = 128;
const DEFAULT_RECOVERABLE_RUN_LIMIT = 256;
const MAX_RECOVERABLE_RUN_LIMIT = 1_024;

export interface DurableInboxStoreOptions {
  rootDir: string;
  leaseMs?: number;
  maxClaim?: number;
  now?: () => Date;
}

/** Persistent command inbox with leases and idempotent enqueue/settlement. */
export class DurableInboxStore implements DurableInboxStoreLike {
  private readonly rootDir: string;
  private readonly leaseMs: number;
  private readonly maxClaim: number;
  private readonly now: () => Date;
  private readonly writeLock: InboxWriteLock;
  /** Cached commands plus the file names a startup pass left unread. */
  private readonly commandState: InboxCommandState = {};
  private initialized = false;
  private initializationFailure: Error | undefined;
  private deferredWarm?: Promise<void>;

  constructor(options: DurableInboxStoreOptions) {
    const root = options.rootDir.trim();
    if (!root) throw new Error('durable inbox rootDir must be non-empty');
    this.rootDir = root;
    this.writeLock = new InboxWriteLock(root);
    this.leaseMs = boundedInteger(options.leaseMs, DEFAULT_LEASE_MS, 1_000, MAX_LEASE_MS);
    this.maxClaim = boundedInteger(options.maxClaim, DEFAULT_CLAIM_LIMIT, 1, MAX_CLAIM_LIMIT);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Startup: names, the records a starting process can act on, and the expired
   * claim requeue those records need.
   *
   * This runs inside the Runner build, so it is on the path to the publish the
   * send control waits for. Parsing every historical command here made that
   * publish scale with the inbox (paired measurement on a 300-command inbox:
   * ~210 ms against ~8 ms), while a completed command can never be claimed,
   * requeued or recovered. Terminal records are therefore stamped and left
   * unread, and the `queued`/`claimed` records that decide admission are fully
   * validated before this returns. `warmDeferredCommands` reads the rest once,
   * after the Runner is published.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializationFailure) throw this.initializationFailure;
    try {
      await mkdir(this.rootDir, { recursive: true });
      await this.withWriteLock(async () => {
        const commands = await this.readCommands({ activeOnly: true });
        await this.requeueExpired(commands, this.now());
      });
      this.initialized = true;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.initializationFailure = normalized;
      throw normalized;
    }
  }

  /**
   * Read the deferred terminal records once, off the startup path.
   *
   * Bounded and idempotent: concurrent callers share one pass, and a completed
   * pass is not repeated. A failure leaves the deferred set in place, so the next
   * full read retries and still fails closed on the same file.
   */
  warmDeferredCommands(): Promise<void> {
    if (!this.commandState.deferred) return Promise.resolve();
    this.deferredWarm ??= this.withWriteLock(async () => {
      await this.readCommands();
    }).catch((error: unknown) => {
      // A later read retries; forgetting the shared promise is what allows that.
      this.deferredWarm = undefined;
      throw error;
    });
    return this.deferredWarm;
  }

  get initializationError(): Error | undefined { return this.initializationFailure; }

  get isInitialized(): boolean { return this.initialized; }

  async enqueue(input: DurableInboxEnqueueInput): Promise<DurableInboxEnqueueOutcome> {
    const normalized = normalizeEnqueueInput(input);
    return this.withWriteLock(async () => {
      const commands = await this.readCommands();
      const byCommandId = commands.find((command) => command.commandId === normalized.commandId);
      if (byCommandId) {
        return sameCommandInput(byCommandId, normalized)
          ? { kind: 'duplicate', command: cloneCommand(byCommandId) }
          : { kind: 'conflict', command: cloneCommand(byCommandId) };
      }
      const byIdempotency = commands.find((command) => command.idempotencyKey === normalized.idempotencyKey);
      if (byIdempotency) {
        return sameCommandInput(byIdempotency, normalized)
          ? { kind: 'duplicate', command: cloneCommand(byIdempotency) }
          : { kind: 'conflict', command: cloneCommand(byIdempotency) };
      }
      const timestamp = this.now().toISOString();
      const command: DurableInboxCommand = {
        version: DURABLE_HARNESS_INBOX_VERSION,
        commandId: normalized.commandId,
        idempotencyKey: normalized.idempotencyKey,
        sessionId: normalized.sessionId,
        runId: normalized.runId,
        type: normalized.type,
        source: normalized.source,
        ...(normalized.occurredAt ? { occurredAt: normalized.occurredAt } : {}),
        payload: normalized.payload,
        status: 'queued',
        enqueuedAt: timestamp,
        updatedAt: timestamp,
        attempts: 0,
      };
      await this.writeCommand(command);
      return { kind: 'enqueued', command: cloneCommand(command) };
    });
  }

  async claim(limit = this.maxClaim, filter?: DurableInboxClaimFilter): Promise<DurableInboxCommand[]> {
    const boundedLimit = boundedInteger(limit, this.maxClaim, 1, this.maxClaim);
    const normalizedFilter = normalizeClaimFilter(filter);
    return this.withWriteLock(async () => {
      const commands = await this.readCommands();
      const now = this.now();
      await this.requeueExpired(commands, now);
      const refreshed = await this.readCommands();
      const queued = refreshed
        .filter((command) => command.status === 'queued' && matchesClaimFilter(command, normalizedFilter))
        .sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.commandId.localeCompare(right.commandId))
        .slice(0, boundedLimit);
      const claimed: DurableInboxCommand[] = [];
      for (const command of queued) {
        const updated: DurableInboxCommand = {
          ...command,
          status: 'claimed',
          updatedAt: now.toISOString(),
          leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString(),
          claimToken: randomId(),
          attempts: command.attempts + 1,
          failureReason: undefined,
        };
        await this.writeCommand(updated);
        claimed.push(cloneCommand(updated));
      }
      return claimed;
    });
  }

  async complete(
    commandId: string,
    resultEventIds: readonly string[] = [],
    claimToken?: string,
  ): Promise<DurableInboxCommand> {
    const normalizedId = normalizeIdentifier(commandId, 'commandId');
    const ids = normalizeResultEventIds(resultEventIds);
    return this.withWriteLock(async () => {
      const command = await this.readRequired(normalizedId);
      if (command.status === 'completed') {
        if (canonicalSerialize(command.resultEventIds ?? []) !== canonicalSerialize(ids)) {
          throw new DurableInboxError('completed command has conflicting result event ids', 'conflict');
        }
        return cloneCommand(command);
      }
      if (command.status !== 'claimed') throw new DurableInboxError(`command ${normalizedId} is not claimed`, 'state');
      assertClaimOwner(command, claimToken);
      const updated: DurableInboxCommand = {
        ...command,
        status: 'completed',
        updatedAt: this.now().toISOString(),
        leaseUntil: undefined,
        claimToken: undefined,
        resultEventIds: ids,
        failureReason: undefined,
      };
      await this.writeCommand(updated);
      return cloneCommand(updated);
    });
  }

  async fail(
    commandId: string,
    reason: string,
    retryable = false,
    claimToken?: string,
  ): Promise<DurableInboxCommand> {
    const normalizedId = normalizeIdentifier(commandId, 'commandId');
    const normalizedReason = normalizeReason(reason);
    return this.withWriteLock(async () => {
      const command = await this.readRequired(normalizedId);
      if (command.status === 'completed') throw new DurableInboxError('completed command cannot fail', 'state');
      if (command.status === 'failed' && !retryable) return cloneCommand(command);
      if (command.status === 'claimed') assertClaimOwner(command, claimToken);
      else if (claimToken !== undefined) throw new DurableInboxError(`command ${normalizedId} is not claimed`, 'state');
      const updated: DurableInboxCommand = {
        ...command,
        status: retryable ? 'queued' : 'failed',
        updatedAt: this.now().toISOString(),
        leaseUntil: undefined,
        claimToken: undefined,
        failureReason: normalizedReason,
      };
      await this.writeCommand(updated);
      return cloneCommand(updated);
    });
  }

  async read(commandId: string): Promise<DurableInboxCommand | null> {
    const normalizedId = normalizeIdentifier(commandId, 'commandId');
    try {
      return cloneCommand(await this.readRequired(normalizedId));
    } catch (error) {
      if (error instanceof DurableInboxError && error.kind === 'missing') return null;
      throw error;
    }
  }

  /** Discover runs whose commands are available for immediate recovery. */
  async listRecoverableRuns(limit = DEFAULT_RECOVERABLE_RUN_LIMIT): Promise<Array<{ sessionId: string; runId: string }>> {
    const boundedLimit = boundedInteger(limit, DEFAULT_RECOVERABLE_RUN_LIMIT, 1, MAX_RECOVERABLE_RUN_LIMIT);
    return this.withWriteLock(async () => {
      // Only a `queued` command is recoverable, so this pass reads the active
      // records instead of the whole inbox; the deferred terminal records cannot
      // contribute a run here by construction.
      const commands = await this.readCommands({ activeOnly: true });
      await this.requeueExpired(commands, this.now());
      const refreshed = await this.readCommands({ activeOnly: true });
      const runs = new Map<string, { sessionId: string; runId: string; enqueuedAt: string }>();
      for (const command of refreshed) {
        // A non-expired claim may still belong to a live process. It only
        // contributes a future wake-up and must not trigger recovery now.
        if (command.status !== 'queued') continue;
        const key = `${command.sessionId}\0${command.runId}`;
        const existing = runs.get(key);
        if (existing && existing.enqueuedAt <= command.enqueuedAt) continue;
        runs.set(key, {
          sessionId: command.sessionId,
          runId: command.runId,
          enqueuedAt: command.enqueuedAt,
        });
      }
      return [...runs.values()]
        .sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt)
          || left.sessionId.localeCompare(right.sessionId)
          || left.runId.localeCompare(right.runId))
        .slice(0, boundedLimit)
        .map(({ sessionId, runId }) => ({ sessionId, runId }));
    });
  }

  /** List runs fenced by a live claim so startup recovery can skip them. */
  async listActiveClaimedRuns(limit = DEFAULT_RECOVERABLE_RUN_LIMIT): Promise<Array<{ sessionId: string; runId: string }>> {
    const boundedLimit = boundedInteger(limit, DEFAULT_RECOVERABLE_RUN_LIMIT, 1, MAX_RECOVERABLE_RUN_LIMIT);
    return this.withWriteLock(async () => {
      const commands = await this.readCommands({ activeOnly: true });
      await this.requeueExpired(commands, this.now());
      const refreshed = await this.readCommands({ activeOnly: true });
      const runs = new Map<string, { sessionId: string; runId: string }>();
      for (const command of refreshed) {
        if (command.status !== 'claimed') continue;
        const key = `${command.sessionId}\0${command.runId}`;
        runs.set(key, { sessionId: command.sessionId, runId: command.runId });
      }
      if (runs.size > boundedLimit) {
        throw new DurableInboxError(`active claimed run count exceeds ${boundedLimit}`, 'state');
      }
      return [...runs.values()].sort((left, right) => (
        left.sessionId.localeCompare(right.sessionId) || left.runId.localeCompare(right.runId)
      ));
    });
  }

  /** Return one bounded wake-up point instead of polling active claims. */
  async nextClaimLeaseExpiry(): Promise<string | undefined> {
    return this.withWriteLock(async () => {
      const commands = await this.readCommands({ activeOnly: true });
      let earliest: string | undefined;
      for (const command of commands) {
        if (command.status !== 'claimed' || !command.leaseUntil) continue;
        if (earliest === undefined || command.leaseUntil < earliest) earliest = command.leaseUntil;
      }
      return earliest;
    });
  }

  private async readRequired(commandId: string): Promise<DurableInboxCommand> {
    const file = this.filePath(commandId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DurableInboxError(`command not found: ${commandId}`, 'missing');
      throw error;
    }
    return validateStoredCommand(parseJson(raw, file), commandId);
  }

  /**
   * The authoritative command set, as a validated in-memory list.
   *
   * The policy - what a startup pass parses, what it defers, and how a deferred
   * record is folded back in - lives in `readInboxCommands`; this only supplies
   * the store's own reader and error type so a corrupt record still fails closed
   * with `kind: 'corrupt'`.
   */
  private async readCommands(options: { activeOnly?: boolean } = {}): Promise<DurableInboxCommand[]> {
    const files = await this.listCommandFiles();
    return readInboxCommands({
      rootDir: this.rootDir,
      files,
      state: this.commandState,
      readCommandFile: (name, raw) => this.readCommandFile(name, raw),
      corrupt: (message) => new DurableInboxError(message, 'corrupt'),
      ...(options.activeOnly ? { activeOnly: true } : {}),
    });
  }

  private async listCommandFiles(): Promise<string[]> {
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || isAtomicWriteTempFile(entry.name)) continue;
      // Unknown names still fail closed: a concurrent writer's temp file is not
      // an authoritative command, and nothing else may live in this directory.
      if (!entry.name.endsWith('.json') && entry.name !== '.inbox.lock') {
        throw new DurableInboxError(`unexpected inbox file: ${entry.name}`, 'corrupt');
      }
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  /**
   * Validate one command file.
   *
   * `raw` is the text the caller already read; without it the file is read here.
   * Both paths run the same validation, so a startup scan that hands over its own
   * text cannot accept a record a later read would reject.
   */
  private async readCommandFile(name: string, raw?: string): Promise<DurableInboxCommand> {
    if (!COMMAND_FILE_PATTERN.test(name)) throw new DurableInboxError(`invalid inbox filename: ${name}`, 'corrupt');
    const commandId = name.slice(0, -'.json'.length);
    const file = join(this.rootDir, name);
    const command = validateStoredCommand(parseJson(raw ?? await readFile(file, 'utf8'), file), undefined);
    if (hashParts(command.commandId) !== commandId) throw new DurableInboxError(`command id/file mismatch: ${name}`, 'corrupt');
    return command;
  }

  private async requeueExpired(commands: readonly DurableInboxCommand[], now: Date): Promise<void> {
    for (const command of commands) {
      if (command.status !== 'claimed' || !command.leaseUntil || Date.parse(command.leaseUntil) > now.getTime()) continue;
      await this.writeCommand({
        ...command,
        status: 'queued',
        updatedAt: now.toISOString(),
        leaseUntil: undefined,
        claimToken: undefined,
      });
    }
  }

  private async writeCommand(command: DurableInboxCommand): Promise<void> {
    const name = `${hashParts(command.commandId)}.json`;
    await writeJsonAtomically(join(this.rootDir, name), command);
    const cached = this.commandState.commandCache;
    if (!cached) return;
    const stamp = await statInboxFile(this.rootDir, name);
    if (!stamp) {
      this.commandState.commandCache = undefined;
      this.commandState.deferred = undefined;
      return;
    }
    this.commandState.commandCache = rememberInboxCommand(cached, name, command, stamp);
    // A deferred record may describe this same file; the next read resolves it
    // from disk instead of folding a stale deferred copy back in.
    this.commandState.deferred?.files.delete(name);
  }

  private filePath(commandId: string): string {
    return join(this.rootDir, `${hashParts(commandId)}.json`);
  }

  /**
   * Run several public inbox operations under one lock acquisition. Durable
   * ingress otherwise takes the write lock four times per event (enqueue, claim,
   * complete plus the event append); the batch keeps the exact same operation
   * order and semantics while collapsing those lock cycles.
   */
  withBatch<T>(operation: () => Promise<T>): Promise<T> {
    return this.writeLock.batch(operation);
  }

  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.writeLock.run(operation);
  }
}

export class DurableInboxError extends Error {
  constructor(message: string, readonly kind: 'missing' | 'corrupt' | 'conflict' | 'state') {
    super(message);
    this.name = 'DurableInboxError';
  }
}

function normalizeEnqueueInput(input: DurableInboxEnqueueInput): DurableInboxEnqueueInput & { commandId: string; payload: Record<string, unknown> } {
  const commandId = input.commandId === undefined ? randomId() : boundedString(input.commandId, 'commandId', MAX_COMMAND_ID_LENGTH);
  const idempotencyKey = boundedString(input.idempotencyKey, 'idempotencyKey', MAX_IDEMPOTENCY_KEY_LENGTH);
  const sessionId = normalizeIdentifier(input.sessionId, 'sessionId');
  const runId = normalizeIdentifier(input.runId, 'runId');
  if (!isEventSource(input.source)) throw new Error('source must be a durable event source');
  const occurredAt = input.occurredAt === undefined ? undefined : normalizeTime(input.occurredAt, 'occurredAt');
  const payload = normalizeJsonValue(input.payload, 'payload');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
  if (Buffer.byteLength(canonicalSerialize(payload), 'utf8') > DURABLE_HARNESS_EVENT_MAX_PAYLOAD_BYTES) {
    throw new Error(`payload exceeds ${DURABLE_HARNESS_EVENT_MAX_PAYLOAD_BYTES} bytes`);
  }
  return {
    ...input,
    commandId,
    idempotencyKey,
    sessionId,
    runId,
    ...(occurredAt ? { occurredAt } : {}),
    payload: payload as Record<string, unknown>,
  };
}

function validateStoredCommand(value: unknown, expectedCommandId: string | undefined): DurableInboxCommand {
  const record = asRecord(value, 'inbox command');
  if (record.version !== DURABLE_HARNESS_INBOX_VERSION) throw new DurableInboxError(`unknown inbox version: ${String(record.version)}`, 'corrupt');
  const commandId = boundedString(record.commandId, 'commandId', MAX_COMMAND_ID_LENGTH);
  if (expectedCommandId !== undefined && commandId !== expectedCommandId) throw new DurableInboxError('command id mismatch', 'corrupt');
  const idempotencyKey = boundedString(record.idempotencyKey, 'idempotencyKey', MAX_IDEMPOTENCY_KEY_LENGTH);
  const sessionId = normalizeIdentifier(record.sessionId, 'sessionId');
  const runId = normalizeIdentifier(record.runId, 'runId');
  const payload = normalizeJsonValue(record.payload, 'payload');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new DurableInboxError('inbox payload must be an object', 'corrupt');
  if (Buffer.byteLength(canonicalSerialize(payload), 'utf8') > DURABLE_HARNESS_EVENT_MAX_PAYLOAD_BYTES) throw new DurableInboxError('inbox payload exceeds size limit', 'corrupt');
  if (!isEventType(record.type)) throw new DurableInboxError(`unknown inbox command type: ${String(record.type)}`, 'corrupt');
  const source = record.source === undefined ? undefined : readEventSource(record.source);
  const occurredAt = record.occurredAt === undefined ? undefined : normalizeTime(record.occurredAt, 'occurredAt');
  if (!Number.isSafeInteger(record.attempts) || (record.attempts as number) < 0) throw new DurableInboxError('invalid inbox attempts', 'corrupt');
  if (record.status !== 'queued' && record.status !== 'claimed' && record.status !== 'completed' && record.status !== 'failed') throw new DurableInboxError('invalid inbox status', 'corrupt');
  const enqueuedAt = normalizeTime(record.enqueuedAt, 'enqueuedAt');
  const updatedAt = normalizeTime(record.updatedAt, 'updatedAt');
  const leaseUntil = record.leaseUntil === undefined ? undefined : normalizeTime(record.leaseUntil, 'leaseUntil');
  if (record.status === 'claimed' && !leaseUntil) throw new DurableInboxError('claimed inbox command requires leaseUntil', 'corrupt');
  const claimToken = record.claimToken === undefined
    ? undefined
    : boundedString(record.claimToken, 'claimToken', MAX_CLAIM_TOKEN_LENGTH);
  if (record.status !== 'claimed' && claimToken) throw new DurableInboxError('only claimed inbox commands may retain a claimToken', 'corrupt');
  const failureReason = record.failureReason === undefined ? undefined : normalizeReason(record.failureReason, 'failureReason');
  const resultEventIds = record.resultEventIds === undefined ? undefined : normalizeResultEventIds(record.resultEventIds);
  return {
    version: DURABLE_HARNESS_INBOX_VERSION,
    commandId,
    idempotencyKey,
    sessionId,
    runId,
    type: record.type,
    ...(source ? { source } : {}),
    ...(occurredAt ? { occurredAt } : {}),
    payload: payload as Record<string, unknown>,
    status: record.status,
    enqueuedAt,
    updatedAt,
    ...(leaseUntil ? { leaseUntil } : {}),
    ...(claimToken ? { claimToken } : {}),
    attempts: record.attempts as number,
    ...(resultEventIds ? { resultEventIds } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
}

function assertClaimOwner(command: DurableInboxCommand, claimToken: string | undefined): void {
  // Commands written before claim ownership was introduced have no token and
  // retain their legacy settlement behavior until their lease is reclaimed.
  if (command.claimToken === undefined) return;
  if (!claimToken || claimToken !== command.claimToken) {
    throw new DurableInboxError(`claim ownership changed for command ${command.commandId}`, 'state');
  }
}

function sameCommandInput(command: DurableInboxCommand, input: DurableInboxEnqueueInput & { commandId: string; payload: Record<string, unknown> }): boolean {
  return command.commandId === input.commandId
    && command.idempotencyKey === input.idempotencyKey
    && command.sessionId === input.sessionId
    && command.runId === input.runId
    && command.type === input.type
    && (command.source === undefined || command.source === input.source)
    && (command.occurredAt === undefined || command.occurredAt === input.occurredAt)
    && canonicalSerialize(command.payload) === canonicalSerialize(input.payload);
}


function normalizeResultEventIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_RESULT_EVENT_IDS) throw new Error('resultEventIds must be a bounded array');
  const ids = value.map((item, index) => boundedString(item, `resultEventIds[${index}]`, MAX_COMMAND_ID_LENGTH));
  if (new Set(ids).size !== ids.length) throw new Error('resultEventIds must not contain duplicates');
  return ids;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must be 1-${max} characters`);
  return normalized;
}

function cloneCommand(command: DurableInboxCommand): DurableInboxCommand {
  return JSON.parse(JSON.stringify(command)) as DurableInboxCommand;
}

function isEventType(value: unknown): value is DurableInboxCommand['type'] {
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

function isEventSource(value: unknown): value is NonNullable<DurableInboxCommand['source']> {
  return value === 'runtime' || value === 'model' || value === 'tool'
    || value === 'app' || value === 'channel' || value === 'system';
}

function readEventSource(value: unknown): NonNullable<DurableInboxCommand['source']> {
  if (!isEventSource(value)) throw new DurableInboxError(`unknown inbox command source: ${String(value)}`, 'corrupt');
  return value;
}
