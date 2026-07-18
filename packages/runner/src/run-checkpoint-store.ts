// Versioned, bounded persistence for active Agent run checkpoints.
//
// This store is deliberately separate from shadow Git checkpoints: Git keeps
// rollback preimages for data/workspace changes, while this store keeps the
// state needed to diagnose or resume an interrupted state-machine run.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  RunCheckpoint,
  RunCheckpointResumeState,
  SessionId,
  StageName,
} from '@littlesheep/types';
import { RUN_CHECKPOINT_VERSION } from '@littlesheep/types';

export const DEFAULT_RUN_CHECKPOINT_MAX_HISTORY = 128 as const;
export const MAX_RUN_CHECKPOINT_MAX_HISTORY = 512 as const;
export const DEFAULT_RUN_CHECKPOINT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_RUN_CHECKPOINT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RUN_CHECKPOINT_MAX_READ_ENTRIES = 256 as const;
export const MAX_RUN_CHECKPOINT_MAX_READ_ENTRIES = 1_024 as const;
export const DEFAULT_RUN_CHECKPOINT_MAX_PER_RUN = 16 as const;
export const MAX_RUN_CHECKPOINT_MAX_PER_RUN = 64 as const;

const MAX_ID_LENGTH = 256;
const MAX_REASON_LENGTH = 4_096;
const MAX_PENDING_EVENT_IDS = 128;
const MAX_CONTEXT_SNAPSHOT_IDS = 128;
const MAX_SIDE_EFFECTS = 256;
const MAX_SIDE_EFFECT_RESOURCE_KEYS = 32;
const MAX_RESUME_TOOL_NAMES = 256;
const MAX_RESUME_EVENTS = 32;
const MAX_RESUME_PATCH_IDS = 128;
const MAX_RESUME_VERIFICATION = 32;
const MAX_DIAGNOSTICS = 64;
const STALE_TEMP_FILE_AGE_MS = 60 * 60 * 1_000;
const STAGE_NAMES: ReadonlySet<StageName> = new Set([
  'enter', 'classify', 'reply', 'ask_user', 'decide', 'execute',
  'recover', 'verify', 'evolve', 'capture', 'finalize',
]);
const CHECKPOINT_STATUSES: ReadonlySet<RunCheckpoint['status']> = new Set([
  'paused',
  'waiting_user',
  'recoverable',
]);

export interface RunCheckpointStoreOptions {
  /** Directory under the LS data root; the store never resolves outside it. */
  rootDir: string;
  maxCheckpoints?: number;
  maxFileBytes?: number;
  maxReadEntries?: number;
  maxPerRun?: number;
  now?: () => Date;
}

export interface RunCheckpointDiagnostic {
  kind: 'corrupt' | 'incompatible' | 'temporary' | 'invalid_name' | 'io';
  file: string;
  message: string;
  recordedAt: string;
}

export interface RunCheckpointStoreDiagnostics {
  rootDir: string;
  scannedFiles: number;
  readFiles: number;
  validFiles: number;
  invalidFiles: number;
  diagnostics: RunCheckpointDiagnostic[];
}

export type RunCheckpointWriteOutcome =
  | { kind: 'written'; checkpoint: RunCheckpoint }
  | { kind: 'duplicate'; checkpoint: RunCheckpoint }
  | { kind: 'conflict'; checkpointId: string; existing: RunCheckpoint };

export class RunCheckpointStoreDisposedError extends Error {
  constructor() {
    super('Run checkpoint store has been disposed.');
    this.name = 'RunCheckpointStoreDisposedError';
  }
}

export class RunCheckpointValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunCheckpointValidationError';
  }
}

interface StoredRecord {
  checkpoint: RunCheckpoint;
  file: string;
  modifiedAt: number;
}

interface ReadRecordResult {
  kind: 'missing' | 'valid' | 'invalid';
  record?: StoredRecord;
}

/**
 * The store serializes all writes. A single tail is stricter than per-run
 * locking, but it makes pruning and same-id conflict detection deterministic
 * and leaves no unbounded per-run Promise/Map references behind.
 */
export class RunCheckpointStore {
  private readonly rootDir: string;
  private readonly maxCheckpoints: number;
  private readonly maxFileBytes: number;
  private readonly maxReadEntries: number;
  private readonly maxPerRun: number;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private scannedFiles = 0;
  private readFiles = 0;
  private validFiles = 0;
  private invalidFiles = 0;
  private readonly diagnosticEntries: RunCheckpointDiagnostic[] = [];

  constructor(options: RunCheckpointStoreOptions) {
    const root = options.rootDir.trim();
    if (!root) throw new RunCheckpointValidationError('Run checkpoint rootDir must be non-empty.');
    this.rootDir = root;
    this.maxCheckpoints = boundedInteger(
      options.maxCheckpoints,
      DEFAULT_RUN_CHECKPOINT_MAX_HISTORY,
      1,
      MAX_RUN_CHECKPOINT_MAX_HISTORY,
    );
    this.maxFileBytes = boundedInteger(
      options.maxFileBytes,
      DEFAULT_RUN_CHECKPOINT_MAX_FILE_BYTES,
      4_096,
      MAX_RUN_CHECKPOINT_MAX_FILE_BYTES,
    );
    this.maxReadEntries = boundedInteger(
      options.maxReadEntries,
      DEFAULT_RUN_CHECKPOINT_MAX_READ_ENTRIES,
      1,
      MAX_RUN_CHECKPOINT_MAX_READ_ENTRIES,
    );
    this.maxPerRun = boundedInteger(
      options.maxPerRun,
      DEFAULT_RUN_CHECKPOINT_MAX_PER_RUN,
      1,
      MAX_RUN_CHECKPOINT_MAX_PER_RUN,
    );
    this.now = options.now ?? (() => new Date());
  }

  /** Create the directory and diagnose stale temporary files. */
  async initialize(): Promise<void> {
    this.ensureUsable();
    await mkdir(this.rootDir, { recursive: true });
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      this.recordDiagnostic('io', this.rootDir, `Unable to inspect checkpoint directory: ${errorMessage(error)}`);
      throw error;
    }
    const now = this.now().getTime();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
      const file = join(this.rootDir, entry.name);
      try {
        const details = await stat(file);
        if (now - details.mtimeMs > STALE_TEMP_FILE_AGE_MS) {
          await rm(file, { force: true });
        } else {
          this.recordDiagnostic('temporary', file, 'Temporary checkpoint file remains from an unfinished atomic write.');
        }
      } catch (error) {
        this.recordDiagnostic('io', file, `Unable to inspect temporary checkpoint file: ${errorMessage(error)}`);
      }
    }
  }

  async write(input: RunCheckpoint): Promise<RunCheckpointWriteOutcome> {
    this.ensureUsable();
    const checkpoint = validateCheckpoint(input, this.maxFileBytes);
    const serialized = stableSerialize(checkpoint);
    return this.enqueueWrite(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const file = this.filePath(checkpoint.id);
      const existing = await this.readFileRecord(file, checkpoint.id);
      if (existing.kind === 'valid' && existing.record) {
        if (stableSerialize(existing.record.checkpoint) === serialized) {
          return { kind: 'duplicate', checkpoint: cloneCheckpoint(existing.record.checkpoint) };
        }
        return {
          kind: 'conflict',
          checkpointId: checkpoint.id,
          existing: cloneCheckpoint(existing.record.checkpoint),
        };
      }
      if (existing.kind === 'invalid') {
        throw new RunCheckpointValidationError(
          `Cannot overwrite an invalid checkpoint file for id "${checkpoint.id}". Inspect store diagnostics first.`,
        );
      }

      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      await this.pruneUnsafe();
      return { kind: 'written', checkpoint: cloneCheckpoint(checkpoint) };
    });
  }

  async read(checkpointId: string): Promise<RunCheckpoint | null> {
    this.ensureUsable();
    const id = normalizeId(checkpointId, 'checkpointId');
    const result = await this.readFileRecord(this.filePath(id), id);
    return result.kind === 'valid' && result.record
      ? cloneCheckpoint(result.record.checkpoint)
      : null;
  }

  async latestForRun(runId: string): Promise<RunCheckpoint | null> {
    const records = await this.list({ runId, limit: 1 });
    return records[0] ? cloneCheckpoint(records[0]) : null;
  }

  async list(options: { runId?: string; limit?: number } = {}): Promise<RunCheckpoint[]> {
    this.ensureUsable();
    const runId = options.runId === undefined ? undefined : normalizeId(options.runId, 'runId');
    const limit = boundedInteger(options.limit, this.maxCheckpoints, 1, this.maxCheckpoints);
    const records = await this.scanRecords();
    return records
      .filter((record) => runId === undefined || String(record.checkpoint.runId) === runId)
      .sort(compareNewest)
      .slice(0, limit)
      .map((record) => cloneCheckpoint(record.checkpoint));
  }

  async remove(checkpointId: string): Promise<boolean> {
    this.ensureUsable();
    const id = normalizeId(checkpointId, 'checkpointId');
    return this.enqueueWrite(async () => {
      const file = this.filePath(id);
      if (!existsSync(file)) return false;
      await rm(file, { force: true });
      return true;
    });
  }

  /** Explicit bounded cleanup hook for shutdown/maintenance. */
  async prune(): Promise<number> {
    this.ensureUsable();
    return this.enqueueWrite(() => this.pruneUnsafe());
  }

  diagnostics(): RunCheckpointStoreDiagnostics {
    return {
      rootDir: this.rootDir,
      scannedFiles: this.scannedFiles,
      readFiles: this.readFiles,
      validFiles: this.validFiles,
      invalidFiles: this.invalidFiles,
      diagnostics: this.diagnosticEntries.map((entry) => ({ ...entry })),
    };
  }

  dispose(): void {
    this.disposed = true;
  }

  private async pruneUnsafe(): Promise<number> {
    const records = (await this.scanRecords()).sort(compareNewest);
    const keep = new Set<string>();
    const perRun = new Map<string, number>();
    for (const record of records) {
      const count = perRun.get(String(record.checkpoint.runId)) ?? 0;
      if (keep.size >= this.maxCheckpoints || count >= this.maxPerRun) continue;
      keep.add(record.file);
      perRun.set(String(record.checkpoint.runId), count + 1);
    }
    let removed = 0;
    for (const record of records) {
      if (keep.has(record.file)) continue;
      try {
        await rm(record.file, { force: true });
        removed += 1;
      } catch (error) {
        this.recordDiagnostic('io', record.file, `Unable to prune checkpoint: ${errorMessage(error)}`);
      }
    }
    return removed;
  }

  private async scanRecords(): Promise<StoredRecord[]> {
    await mkdir(this.rootDir, { recursive: true });
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      this.recordDiagnostic('io', this.rootDir, `Unable to list checkpoints: ${errorMessage(error)}`);
      return [];
    }
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(this.rootDir, entry.name));
    this.scannedFiles += files.length;
    const filesByAge: Array<{ file: string; modifiedAt: number }> = [];
    for (const file of files) {
      try {
        filesByAge.push({ file, modifiedAt: (await stat(file)).mtimeMs });
      } catch (error) {
        this.recordDiagnostic('io', file, `Unable to stat checkpoint: ${errorMessage(error)}`);
      }
    }
    filesByAge.sort((left, right) => right.modifiedAt - left.modifiedAt);
    const boundedFiles = filesByAge.slice(0, this.maxReadEntries).map((entry) => entry.file);
    if (files.length > boundedFiles.length) {
      this.recordDiagnostic('io', this.rootDir, `Checkpoint scan capped at ${this.maxReadEntries} files.`);
    }
    const records: StoredRecord[] = [];
    for (const file of boundedFiles) {
      const result = await this.readFileRecord(file);
      if (result.kind === 'valid' && result.record) records.push(result.record);
    }
    return records;
  }

  private async readFileRecord(file: string, expectedId?: string): Promise<ReadRecordResult> {
    if (!existsSync(file)) return { kind: 'missing' };
    this.readFiles += 1;
    let raw: string;
    try {
      const details = await stat(file);
      if (details.size > this.maxFileBytes) {
        this.invalidFiles += 1;
        this.recordDiagnostic('corrupt', file, `Checkpoint file exceeds the ${this.maxFileBytes}-byte limit.`);
        return { kind: 'invalid' };
      }
      raw = await readFile(file, 'utf8');
    } catch (error) {
      this.invalidFiles += 1;
      this.recordDiagnostic('io', file, `Unable to read checkpoint: ${errorMessage(error)}`);
      return { kind: 'invalid' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.invalidFiles += 1;
      this.recordDiagnostic('corrupt', file, `Invalid checkpoint JSON: ${errorMessage(error)}`);
      return { kind: 'invalid' };
    }
    try {
      const checkpoint = validateCheckpoint(parsed, this.maxFileBytes);
      if (expectedId !== undefined && checkpoint.id !== expectedId) {
        this.invalidFiles += 1;
        this.recordDiagnostic('invalid_name', file, 'Checkpoint id does not match its hashed filename lookup.');
        return { kind: 'invalid' };
      }
      if (checkpointFileHash(checkpoint.id) !== idFromFileName(file)) {
        this.invalidFiles += 1;
        this.recordDiagnostic('invalid_name', file, 'Checkpoint filename hash does not match the stored checkpoint id.');
        return { kind: 'invalid' };
      }
      this.validFiles += 1;
      const details = await stat(file);
      return { kind: 'valid', record: { checkpoint, file, modifiedAt: details.mtimeMs } };
    } catch (error) {
      this.invalidFiles += 1;
      const kind = error instanceof RunCheckpointValidationError && /version/i.test(error.message)
        ? 'incompatible'
        : 'corrupt';
      this.recordDiagnostic(kind, file, errorMessage(error));
      return { kind: 'invalid' };
    }
  }

  private filePath(checkpointId: string): string {
    return join(this.rootDir, `${checkpointFileHash(checkpointId)}.json`);
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureUsable();
    const previous = this.writeTail;
    const current = previous.catch(() => undefined).then(() => {
      this.ensureUsable();
      return operation();
    });
    this.writeTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private recordDiagnostic(
    kind: RunCheckpointDiagnostic['kind'],
    file: string,
    message: string,
  ): void {
    if (this.diagnosticEntries.length >= MAX_DIAGNOSTICS) this.diagnosticEntries.shift();
    this.diagnosticEntries.push({ kind, file, message, recordedAt: this.now().toISOString() });
  }

  private ensureUsable(): void {
    if (this.disposed) throw new RunCheckpointStoreDisposedError();
  }
}

function validateCheckpoint(value: unknown, maxFileBytes: number): RunCheckpoint {
  if (!isRecord(value)) throw new RunCheckpointValidationError('Checkpoint must be an object.');
  if (value.version !== RUN_CHECKPOINT_VERSION) {
    throw new RunCheckpointValidationError(`Unsupported run checkpoint version: ${String(value.version)}.`);
  }
  const id = normalizeId(value.id, 'checkpoint.id');
  const runId = normalizeId(value.runId, 'checkpoint.runId');
  const sessionId = normalizeId(value.sessionId, 'checkpoint.sessionId') as SessionId;
  if (!CHECKPOINT_STATUSES.has(value.status as RunCheckpoint['status'])) {
    throw new RunCheckpointValidationError(`Invalid checkpoint status: ${String(value.status)}.`);
  }
  if (typeof value.currentStage !== 'string' || !STAGE_NAMES.has(value.currentStage as StageName)) {
    throw new RunCheckpointValidationError(`Invalid checkpoint stage: ${String(value.currentStage)}.`);
  }
  const taskBookRevision = boundedSafeInteger(value.taskBookRevision, 'checkpoint.taskBookRevision', 0);
  const eventCursor = boundedSafeInteger(value.eventCursor, 'checkpoint.eventCursor', 0);
  const pendingEventIds = boundedStringArray(value.pendingEventIds, MAX_PENDING_EVENT_IDS, 'checkpoint.pendingEventIds');
  const contextSnapshotIds = boundedStringArray(value.contextSnapshotIds, MAX_CONTEXT_SNAPSHOT_IDS, 'checkpoint.contextSnapshotIds');
  const sideEffects = Array.isArray(value.sideEffects) ? value.sideEffects : null;
  if (!sideEffects || sideEffects.length > MAX_SIDE_EFFECTS) {
    throw new RunCheckpointValidationError('checkpoint.sideEffects is missing or exceeds its limit.');
  }
  const normalizedSideEffects = sideEffects.map((effect, index) => validateSideEffect(effect, index));
  if (!isRecord(value.loopBudget)) throw new RunCheckpointValidationError('checkpoint.loopBudget is required.');
  const loopBudget = validateLoopBudget(value.loopBudget);
  const createdAt = normalizeTimestamp(value.createdAt, 'checkpoint.createdAt');
  const reason = boundedText(value.reason, MAX_REASON_LENGTH, 'checkpoint.reason');
  const currentStepId = value.currentStepId === undefined
    ? undefined
    : boundedText(value.currentStepId, MAX_ID_LENGTH, 'checkpoint.currentStepId');
  const resumeState = value.resumeState === undefined
    ? undefined
    : validateResumeState(value.resumeState);
  const checkpoint: RunCheckpoint = {
    version: RUN_CHECKPOINT_VERSION,
    id,
    runId,
    sessionId,
    status: value.status as RunCheckpoint['status'],
    currentStage: value.currentStage as StageName,
    ...(currentStepId ? { currentStepId } : {}),
    ...(value.taskBook === undefined ? {} : { taskBook: cloneJson(value.taskBook) as RunCheckpoint['taskBook'] }),
    taskBookRevision,
    ...(value.taskExecution === undefined ? {} : { taskExecution: cloneJson(value.taskExecution) as RunCheckpoint['taskExecution'] }),
    eventCursor,
    pendingEventIds,
    ...(value.runtimeEventQueue === undefined ? {} : { runtimeEventQueue: cloneJson(value.runtimeEventQueue) as RunCheckpoint['runtimeEventQueue'] }),
    ...(value.runtimeControl === undefined ? {} : { runtimeControl: cloneJson(value.runtimeControl) as RunCheckpoint['runtimeControl'] }),
    contextSnapshotIds,
    sideEffects: normalizedSideEffects,
    loopBudget,
    ...(resumeState ? { resumeState } : {}),
    createdAt,
    reason,
  };
  const serialized = stableSerialize(checkpoint);
  if (Buffer.byteLength(serialized, 'utf8') > maxFileBytes) {
    throw new RunCheckpointValidationError(`Checkpoint exceeds the ${maxFileBytes}-byte limit.`);
  }
  return checkpoint;
}

function validateSideEffect(value: unknown, index: number): RunCheckpoint['sideEffects'][number] {
  if (!isRecord(value)) throw new RunCheckpointValidationError(`checkpoint.sideEffects[${index}] must be an object.`);
  const idempotencyKey = boundedText(value.idempotencyKey, 512, `checkpoint.sideEffects[${index}].idempotencyKey`);
  const toolName = boundedText(value.toolName, MAX_ID_LENGTH, `checkpoint.sideEffects[${index}].toolName`);
  const status = value.status;
  if (status !== 'planned' && status !== 'in_progress' && status !== 'succeeded' && status !== 'failed' && status !== 'unknown') {
    throw new RunCheckpointValidationError(`checkpoint.sideEffects[${index}].status is invalid.`);
  }
  const output: RunCheckpoint['sideEffects'][number] = { idempotencyKey, toolName, status };
  for (const field of ['inputHash', 'stepId', 'callId', 'evidenceRef', 'error'] as const) {
    if (value[field] !== undefined) output[field] = boundedText(value[field], field === 'error' ? 2_048 : 512, `checkpoint.sideEffects[${index}].${field}`);
  }
  if (value.effectKind !== undefined) {
    if (value.effectKind !== 'local_mutation' && value.effectKind !== 'external' && value.effectKind !== 'unknown') {
      throw new RunCheckpointValidationError(`checkpoint.sideEffects[${index}].effectKind is invalid.`);
    }
    output.effectKind = value.effectKind;
  }
  if (value.resourceKeys !== undefined) {
    output.resourceKeys = boundedStringArray(value.resourceKeys, MAX_SIDE_EFFECT_RESOURCE_KEYS, `checkpoint.sideEffects[${index}].resourceKeys`);
  }
  for (const field of ['startedAt', 'endedAt'] as const) {
    if (value[field] !== undefined) output[field] = normalizeTimestamp(value[field], `checkpoint.sideEffects[${index}].${field}`);
  }
  return output;
}

function validateResumeState(value: unknown): RunCheckpointResumeState {
  if (!isRecord(value) || value.version !== 1) {
    throw new RunCheckpointValidationError('checkpoint.resumeState has an unsupported version.');
  }
  const origin = value.origin;
  if (origin !== 'app' && origin !== 'channel' && origin !== 'cli' && origin !== 'test') {
    throw new RunCheckpointValidationError('checkpoint.resumeState.origin is invalid.');
  }
  const permissionPolicyId = value.permissionPolicyId;
  if (permissionPolicyId !== 'full' && permissionPolicyId !== 'research' && permissionPolicyId !== 'restricted') {
    throw new RunCheckpointValidationError('checkpoint.resumeState.permissionPolicyId is invalid.');
  }
  const reasoning = value.reasoning;
  if (reasoning !== 'auto' && reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high' && reasoning !== 'ultra') {
    throw new RunCheckpointValidationError('checkpoint.resumeState.reasoning is invalid.');
  }
  const attachmentCount = boundedSafeInteger(value.attachmentCount, 'checkpoint.resumeState.attachmentCount', 0);
  const workspaceContext = value.workspaceContext === undefined
    ? undefined
    : validateWorkspaceContext(value.workspaceContext);
  const availableToolNames = boundedStringArray(value.availableToolNames, MAX_RESUME_TOOL_NAMES, 'checkpoint.resumeState.availableToolNames');
  const appliedTaskBookPatchIds = boundedStringArray(value.appliedTaskBookPatchIds, MAX_RESUME_PATCH_IDS, 'checkpoint.resumeState.appliedTaskBookPatchIds');
  if (!Array.isArray(value.deferredRuntimeEvents) || value.deferredRuntimeEvents.length > MAX_RESUME_EVENTS) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.deferredRuntimeEvents is missing or exceeds its limit.');
  }
  const recoveryAttempts = boundedSafeInteger(value.recoveryAttempts, 'checkpoint.resumeState.recoveryAttempts', 0);
  const replanAttempts = boundedSafeInteger(value.replanAttempts, 'checkpoint.resumeState.replanAttempts', 0);
  const maxReplanAttempts = boundedSafeInteger(value.maxReplanAttempts, 'checkpoint.resumeState.maxReplanAttempts', 0);
  if (!Array.isArray(value.verificationHistory) || value.verificationHistory.length > MAX_RESUME_VERIFICATION) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.verificationHistory is missing or exceeds its limit.');
  }
  return {
    version: 1,
    inboundMessageId: boundedText(value.inboundMessageId, MAX_ID_LENGTH, 'checkpoint.resumeState.inboundMessageId'),
    cwd: boundedText(value.cwd, 4_096, 'checkpoint.resumeState.cwd'),
    ...(workspaceContext ? { workspaceContext } : {}),
    model: boundedText(value.model, 512, 'checkpoint.resumeState.model'),
    origin,
    permissionPolicyId,
    reasoning,
    behaviorModeId: boundedText(value.behaviorModeId, MAX_ID_LENGTH, 'checkpoint.resumeState.behaviorModeId'),
    availableToolNames,
    attachmentCount,
    ...(value.classification === undefined ? {} : { classification: cloneJson(value.classification) as RunCheckpointResumeState['classification'] }),
    ...(value.needAssessment === undefined ? {} : { needAssessment: cloneJson(value.needAssessment) as RunCheckpointResumeState['needAssessment'] }),
    ...(value.plan === undefined ? {} : { plan: cloneJson(value.plan) as RunCheckpointResumeState['plan'] }),
    appliedTaskBookPatchIds,
    deferredRuntimeEvents: cloneJson(value.deferredRuntimeEvents) as RunCheckpointResumeState['deferredRuntimeEvents'],
    recoveryAttempts,
    replanAttempts,
    maxReplanAttempts,
    verificationHistory: cloneJson(value.verificationHistory) as RunCheckpointResumeState['verificationHistory'],
  };
}

function validateWorkspaceContext(value: unknown): NonNullable<RunCheckpoint['resumeState']>['workspaceContext'] {
  if (!isRecord(value)) throw new RunCheckpointValidationError('checkpoint.resumeState.workspaceContext must be an object.');
  if (value.boundaryKind !== 'agent_workplace' && value.boundaryKind !== 'user_workplace' && value.boundaryKind !== 'project') {
    throw new RunCheckpointValidationError('checkpoint.resumeState.workspaceContext.boundaryKind is invalid.');
  }
  return {
    boundaryKind: value.boundaryKind,
    ...(value.projectId === undefined ? {} : { projectId: boundedText(value.projectId, MAX_ID_LENGTH, 'checkpoint.resumeState.workspaceContext.projectId') }),
  };
}

function validateLoopBudget(value: Record<string, unknown>): RunCheckpoint['loopBudget'] {
  return {
    attemptsUsed: boundedSafeInteger(value.attemptsUsed, 'loopBudget.attemptsUsed', 0),
    maxAttempts: boundedSafeInteger(value.maxAttempts, 'loopBudget.maxAttempts', 0),
    elapsedMs: boundedSafeInteger(value.elapsedMs, 'loopBudget.elapsedMs', 0),
    maxElapsedMs: boundedSafeInteger(value.maxElapsedMs, 'loopBudget.maxElapsedMs', 0),
    noProgressRounds: boundedSafeInteger(value.noProgressRounds, 'loopBudget.noProgressRounds', 0),
    maxNoProgressRounds: boundedSafeInteger(value.maxNoProgressRounds, 'loopBudget.maxNoProgressRounds', 0),
    ...(value.costUsed === undefined ? {} : { costUsed: boundedFiniteNumber(value.costUsed, 'loopBudget.costUsed', 0) }),
    ...(value.maxCost === undefined ? {} : { maxCost: boundedFiniteNumber(value.maxCost, 'loopBudget.maxCost', 0) }),
  };
}

function boundedStringArray(value: unknown, maximum: number, field: string): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RunCheckpointValidationError(`${field} is missing or exceeds its limit.`);
  }
  const values = value.map((item) => boundedText(item, MAX_ID_LENGTH, field));
  if (new Set(values).size !== values.length) throw new RunCheckpointValidationError(`${field} contains duplicates.`);
  return values;
}

function boundedText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string') throw new RunCheckpointValidationError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new RunCheckpointValidationError(`${field} is empty or too long.`);
  return normalized;
}

function normalizeId(value: unknown, field: string): string {
  return boundedText(value, MAX_ID_LENGTH, field);
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new RunCheckpointValidationError(`${field} must be a valid timestamp.`);
  }
  return new Date(value).toISOString();
}

function boundedSafeInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RunCheckpointValidationError(`${field} must be a safe integer >= ${minimum}.`);
  }
  return value as number;
}

function boundedFiniteNumber(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new RunCheckpointValidationError(`${field} must be a finite number >= ${minimum}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function cloneCheckpoint(value: RunCheckpoint): RunCheckpoint {
  return cloneJson(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function checkpointFileHash(checkpointId: string): string {
  return createHash('sha256').update(checkpointId, 'utf8').digest('hex');
}

function idFromFileName(file: string): string {
  return basenameWithoutExtension(file);
}

function basenameWithoutExtension(file: string): string {
  const name = basename(file);
  return name.endsWith('.json') ? name.slice(0, -5) : name;
}

function compareNewest(left: StoredRecord, right: StoredRecord): number {
  const time = Date.parse(right.checkpoint.createdAt) - Date.parse(left.checkpoint.createdAt);
  return time || right.modifiedAt - left.modifiedAt;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value as number));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
