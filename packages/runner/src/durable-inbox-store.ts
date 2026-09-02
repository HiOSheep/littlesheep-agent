// Durable Harness command inbox: leased claims, restart recovery and
// idempotent completion without owning tool or model execution.
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { acquireLock } from '@littlesheep/session';
import type {
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
  normalizeIdentifier,
  normalizeJsonValue,
  normalizeReason,
  normalizeTime,
  parseJson,
  randomId,
  writeJsonAtomically,
} from './durable-store-utils.js';

const COMMAND_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;
const MAX_COMMAND_ID_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_RESULT_EVENT_IDS = 128;
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const MAX_LEASE_MS = 60 * 60 * 1_000;
const DEFAULT_CLAIM_LIMIT = 16;
const MAX_CLAIM_LIMIT = 128;

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
  private writeTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private initializationFailure: Error | undefined;

  constructor(options: DurableInboxStoreOptions) {
    const root = options.rootDir.trim();
    if (!root) throw new Error('durable inbox rootDir must be non-empty');
    this.rootDir = root;
    this.leaseMs = boundedInteger(options.leaseMs, DEFAULT_LEASE_MS, 1_000, MAX_LEASE_MS);
    this.maxClaim = boundedInteger(options.maxClaim, DEFAULT_CLAIM_LIMIT, 1, MAX_CLAIM_LIMIT);
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializationFailure) throw this.initializationFailure;
    try {
      await mkdir(this.rootDir, { recursive: true });
      await this.withWriteLock(async () => {
        const commands = await this.readCommands();
        await this.requeueExpired(commands, this.now());
      });
      this.initialized = true;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.initializationFailure = normalized;
      throw normalized;
    }
  }

  get initializationError(): Error | undefined {
    return this.initializationFailure;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

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

  async claim(limit = this.maxClaim): Promise<DurableInboxCommand[]> {
    const boundedLimit = boundedInteger(limit, this.maxClaim, 1, this.maxClaim);
    return this.withWriteLock(async () => {
      const commands = await this.readCommands();
      const now = this.now();
      await this.requeueExpired(commands, now);
      const refreshed = await this.readCommands();
      const queued = refreshed
        .filter((command) => command.status === 'queued')
        .sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.commandId.localeCompare(right.commandId))
        .slice(0, boundedLimit);
      const claimed: DurableInboxCommand[] = [];
      for (const command of queued) {
        const updated: DurableInboxCommand = {
          ...command,
          status: 'claimed',
          updatedAt: now.toISOString(),
          leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString(),
          attempts: command.attempts + 1,
          failureReason: undefined,
        };
        await this.writeCommand(updated);
        claimed.push(cloneCommand(updated));
      }
      return claimed;
    });
  }

  async complete(commandId: string, resultEventIds: readonly string[] = []): Promise<DurableInboxCommand> {
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
      const updated: DurableInboxCommand = {
        ...command,
        status: 'completed',
        updatedAt: this.now().toISOString(),
        leaseUntil: undefined,
        resultEventIds: ids,
        failureReason: undefined,
      };
      await this.writeCommand(updated);
      return cloneCommand(updated);
    });
  }

  async fail(commandId: string, reason: string, retryable = false): Promise<DurableInboxCommand> {
    const normalizedId = normalizeIdentifier(commandId, 'commandId');
    const normalizedReason = normalizeReason(reason);
    return this.withWriteLock(async () => {
      const command = await this.readRequired(normalizedId);
      if (command.status === 'completed') throw new DurableInboxError('completed command cannot fail', 'state');
      if (command.status === 'failed' && !retryable) return cloneCommand(command);
      const updated: DurableInboxCommand = {
        ...command,
        status: retryable ? 'queued' : 'failed',
        updatedAt: this.now().toISOString(),
        leaseUntil: undefined,
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

  private async readCommands(): Promise<DurableInboxCommand[]> {
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.tmp') || (!entry.name.endsWith('.json') && entry.name !== '.inbox.lock'))) {
        throw new DurableInboxError(`unexpected inbox file: ${entry.name}`, 'corrupt');
      }
    }
    const commands: DurableInboxCommand[] = [];
    const commandIds = new Set<string>();
    const idempotencyKeys = new Set<string>();
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!COMMAND_FILE_PATTERN.test(entry.name)) throw new DurableInboxError(`invalid inbox filename: ${entry.name}`, 'corrupt');
      const commandId = entry.name.slice(0, -'.json'.length);
      const command = validateStoredCommand(parseJson(await readFile(join(this.rootDir, entry.name), 'utf8'), join(this.rootDir, entry.name)), undefined);
      if (hashParts(command.commandId) !== commandId) throw new DurableInboxError(`command id/file mismatch: ${entry.name}`, 'corrupt');
      if (commandIds.has(command.commandId)) throw new DurableInboxError(`duplicate command id: ${command.commandId}`, 'corrupt');
      if (idempotencyKeys.has(command.idempotencyKey)) throw new DurableInboxError(`duplicate inbox idempotency key: ${command.idempotencyKey}`, 'corrupt');
      commandIds.add(command.commandId);
      idempotencyKeys.add(command.idempotencyKey);
      commands.push(command);
    }
    return commands;
  }

  private async requeueExpired(commands: readonly DurableInboxCommand[], now: Date): Promise<void> {
    for (const command of commands) {
      if (command.status !== 'claimed' || !command.leaseUntil || Date.parse(command.leaseUntil) > now.getTime()) continue;
      await this.writeCommand({
        ...command,
        status: 'queued',
        updatedAt: now.toISOString(),
        leaseUntil: undefined,
      });
    }
  }

  private async writeCommand(command: DurableInboxCommand): Promise<void> {
    await writeJsonAtomically(this.filePath(command.commandId), command);
  }

  private filePath(commandId: string): string {
    return join(this.rootDir, `${hashParts(commandId)}.json`);
  }

  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.writeTail.catch(() => undefined).then(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const lock = await acquireLock(join(this.rootDir, '.inbox'), 60_000);
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    });
    this.writeTail = current.then(() => undefined, () => undefined);
    return current;
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
  const payload = normalizeJsonValue(input.payload, 'payload');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
  if (Buffer.byteLength(canonicalSerialize(payload), 'utf8') > DURABLE_HARNESS_EVENT_MAX_PAYLOAD_BYTES) {
    throw new Error(`payload exceeds ${DURABLE_HARNESS_EVENT_MAX_PAYLOAD_BYTES} bytes`);
  }
  return { ...input, commandId, idempotencyKey, sessionId, runId, payload: payload as Record<string, unknown> };
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
  if (!Number.isSafeInteger(record.attempts) || (record.attempts as number) < 0) throw new DurableInboxError('invalid inbox attempts', 'corrupt');
  if (record.status !== 'queued' && record.status !== 'claimed' && record.status !== 'completed' && record.status !== 'failed') throw new DurableInboxError('invalid inbox status', 'corrupt');
  const enqueuedAt = normalizeTime(record.enqueuedAt, 'enqueuedAt');
  const updatedAt = normalizeTime(record.updatedAt, 'updatedAt');
  const leaseUntil = record.leaseUntil === undefined ? undefined : normalizeTime(record.leaseUntil, 'leaseUntil');
  if (record.status === 'claimed' && !leaseUntil) throw new DurableInboxError('claimed inbox command requires leaseUntil', 'corrupt');
  const failureReason = record.failureReason === undefined ? undefined : normalizeReason(record.failureReason, 'failureReason');
  const resultEventIds = record.resultEventIds === undefined ? undefined : normalizeResultEventIds(record.resultEventIds);
  return {
    version: DURABLE_HARNESS_INBOX_VERSION,
    commandId,
    idempotencyKey,
    sessionId,
    runId,
    type: record.type,
    payload: payload as Record<string, unknown>,
    status: record.status,
    enqueuedAt,
    updatedAt,
    ...(leaseUntil ? { leaseUntil } : {}),
    attempts: record.attempts as number,
    ...(resultEventIds ? { resultEventIds } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
}

function sameCommandInput(command: DurableInboxCommand, input: DurableInboxEnqueueInput & { commandId: string; payload: Record<string, unknown> }): boolean {
  return command.commandId === input.commandId
    && command.idempotencyKey === input.idempotencyKey
    && command.sessionId === input.sessionId
    && command.runId === input.runId
    && command.type === input.type
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
