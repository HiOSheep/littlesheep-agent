// Versioned, bounded persistence for active Agent run checkpoints.
//
// This store is deliberately separate from shadow Git checkpoints: Git keeps
// rollback preimages for data/workspace changes, while this store keeps the
// state needed to diagnose or resume an interrupted state-machine run.
//
// Boundaries: the schema and file naming live in `run-checkpoint-codec.ts`, one
// directory report lives in `run-checkpoint-scan.ts`, and this file owns the
// files themselves - atomic writes, capacity, retention and the diagnostic
// ledger. Counts always describe the latest scan, never the process lifetime.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunCheckpoint, SessionId } from '@littlesheep/types';
import { MAX_PERSISTED_CONTEXT_SNAPSHOT_IDS, checkpointFileHash, cloneCheckpoint, errorMessage, stableSerialize, validateCheckpoint } from './run-checkpoint-codec.js';
import { RunCheckpointStoreDisposedError, RunCheckpointValidationError } from './run-checkpoint-errors.js';
import {
  compareCheckpointRecordsNewest,
  readRunCheckpointRecord,
  scanRunCheckpointDirectory,
  type RunCheckpointDiagnostic,
  type RunCheckpointScanReport,
  type RunCheckpointStoreDiagnostics,
  type RunCheckpointStoredRecord,
} from './run-checkpoint-scan.js';

export type {
  RunCheckpointDiagnostic,
  RunCheckpointStoreDiagnostics,
  RunCheckpointStoredRecord,
} from './run-checkpoint-scan.js';
export { RunCheckpointStoreDisposedError, RunCheckpointValidationError } from './run-checkpoint-errors.js';

export const DEFAULT_RUN_CHECKPOINT_MAX_HISTORY = 128 as const;
export const MAX_RUN_CHECKPOINT_MAX_HISTORY = 512 as const;
export const DEFAULT_RUN_CHECKPOINT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_RUN_CHECKPOINT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RUN_CHECKPOINT_MAX_READ_ENTRIES = 256 as const;
export const MAX_RUN_CHECKPOINT_MAX_READ_ENTRIES = 1_024 as const;
export const DEFAULT_RUN_CHECKPOINT_MAX_PER_RUN = 16 as const;
export const MAX_RUN_CHECKPOINT_MAX_PER_RUN = 64 as const;

const MAX_DIAGNOSTICS = 64;
const STALE_TEMP_FILE_AGE_MS = 60 * 60 * 1_000;

export interface RunCheckpointStoreOptions {
  /** Directory under the LS data root; the store never resolves outside it. */
  rootDir: string;
  maxCheckpoints?: number;
  maxFileBytes?: number;
  maxReadEntries?: number;
  maxPerRun?: number;
  /** Mutable checkpoint ids that must survive ordinary history pruning. */
  protectedCheckpointIds?: () => Promise<ReadonlySet<string>>;
  /** Active continuation run ids whose latest durable boundaries must survive pruning. */
  protectedRunIds?: () => Promise<ReadonlySet<string>>;
  now?: () => Date;
}

export type RunCheckpointWriteOutcome =
  | { kind: 'written'; checkpoint: RunCheckpoint }
  | { kind: 'duplicate'; checkpoint: RunCheckpoint }
  | { kind: 'conflict'; checkpointId: string; existing: RunCheckpoint };

/**
 * The store serializes all writes. A single tail is stricter than per-run
 * locking, but it makes pruning and same-id conflict detection deterministic
 * and leaves no unbounded per-Promise/Map references behind.
 */
export class RunCheckpointStore {
  private readonly rootDir: string;
  private readonly maxCheckpoints: number;
  private readonly maxFileBytes: number;
  private readonly maxReadEntries: number;
  private readonly maxPerRun: number;
  private readonly protectedCheckpointIds?: () => Promise<ReadonlySet<string>>;
  private readonly protectedRunIds?: () => Promise<ReadonlySet<string>>;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();
  private disposed = false;
  /**
   * Findings recorded outside a directory scan: startup inspection, pruning, and
   * targeted reads or writes. A scan cannot see these for itself, so they are
   * kept instead of being replaced by the next scan.
   */
  private readonly retainedFindings: RunCheckpointDiagnostic[] = [];
  private latestScan: RunCheckpointScanReport | null = null;

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
    this.protectedCheckpointIds = options.protectedCheckpointIds;
    this.protectedRunIds = options.protectedRunIds;
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
    const checkpoint = validateCheckpoint(input, this.maxFileBytes, MAX_PERSISTED_CONTEXT_SNAPSHOT_IDS);
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
    const id = normalizeCheckpointId(checkpointId);
    const result = await this.readFileRecord(this.filePath(id), id);
    return result.kind === 'valid' && result.record
      ? cloneCheckpoint(result.record.checkpoint)
      : null;
  }

  async latestForRun(runId: string): Promise<RunCheckpoint | null> {
    const records = await this.list({ runId, limit: 1 });
    return records[0] ? cloneCheckpoint(records[0]) : null;
  }

  async list(options: {
    runId?: string;
    sessionId?: SessionId;
    status?: RunCheckpoint['status'];
    limit?: number;
  } = {}): Promise<RunCheckpoint[]> {
    this.ensureUsable();
    const runId = options.runId === undefined ? undefined : normalizeCheckpointId(options.runId);
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId);
    const limit = boundedInteger(options.limit, this.maxCheckpoints, 1, this.maxCheckpoints);
    const records = await this.scanRecords();
    return records
      .filter((record) => runId === undefined || String(record.checkpoint.runId) === runId)
      .filter((record) => sessionId === undefined || String(record.checkpoint.sessionId) === sessionId)
      .filter((record) => options.status === undefined || record.checkpoint.status === options.status)
      .sort(compareCheckpointRecordsNewest)
      .slice(0, limit)
      .map((record) => cloneCheckpoint(record.checkpoint));
  }

  async remove(checkpointId: string): Promise<boolean> {
    this.ensureUsable();
    const id = normalizeCheckpointId(checkpointId);
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
    const scan = this.latestScan;
    return {
      rootDir: this.rootDir,
      scannedFiles: scan?.scannedFiles ?? 0,
      readFiles: scan?.readFiles ?? 0,
      validFiles: scan?.validFiles ?? 0,
      invalidFiles: scan?.invalidFiles ?? 0,
      warningFindings: boundedDiagnostics([
        ...this.retainedFindings,
        ...(scan?.warningFindings ?? []),
      ]),
      diagnostics: boundedDiagnostics([
        ...this.retainedFindings,
        ...(scan?.recordFindings ?? []),
        ...(scan?.warningFindings ?? []),
      ]),
    };
  }

  dispose(): void {
    this.disposed = true;
  }

  private async pruneUnsafe(): Promise<number> {
    const records = (await this.scanRecords()).sort(compareCheckpointRecordsNewest);
    const keep = new Set<string>();
    const perRun = new Map<string, number>();
    let protectedIds: ReadonlySet<string> = new Set();
    let protectedRunIds: ReadonlySet<string> = new Set();
    if (this.protectedCheckpointIds || this.protectedRunIds) {
      try {
        protectedIds = await this.protectedCheckpointIds?.() ?? new Set();
        protectedRunIds = await this.protectedRunIds?.() ?? new Set();
      } catch (error) {
        this.recordDiagnostic('io', this.rootDir, `Unable to resolve protected checkpoints; pruning skipped: ${errorMessage(error)}`);
        return 0;
      }
    }
    for (const record of records) {
      if (!protectedIds.has(record.checkpoint.id) && !protectedRunIds.has(String(record.checkpoint.runId))) continue;
      keep.add(record.file);
      const runId = String(record.checkpoint.runId);
      perRun.set(runId, (perRun.get(runId) ?? 0) + 1);
    }
    let retainedHistory = 0;
    for (const record of records) {
      if (keep.has(record.file)) continue;
      const count = perRun.get(String(record.checkpoint.runId)) ?? 0;
      if (retainedHistory >= this.maxCheckpoints || count >= this.maxPerRun) continue;
      keep.add(record.file);
      retainedHistory += 1;
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

  /** Scan once and remember that report as the current state of the directory. */
  private async scanRecords(): Promise<RunCheckpointStoredRecord[]> {
    const report = await scanRunCheckpointDirectory({
      rootDir: this.rootDir,
      maxFileBytes: this.maxFileBytes,
      maxReadEntries: this.maxReadEntries,
      now: this.now,
    });
    this.latestScan = report;
    return report.records;
  }

  /** Read one file and keep its findings, without touching the scan counts. */
  private async readFileRecord(file: string, expectedId?: string) {
    const result = await readRunCheckpointRecord({
      file,
      maxFileBytes: this.maxFileBytes,
      now: this.now,
      ...(expectedId === undefined ? {} : { expectedId }),
    });
    for (const finding of result.findings) this.rememberFinding(finding);
    return result;
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
    this.rememberFinding({ kind, file, message, recordedAt: this.now().toISOString() });
  }

  private rememberFinding(finding: RunCheckpointDiagnostic): void {
    if (this.retainedFindings.length >= MAX_DIAGNOSTICS) this.retainedFindings.shift();
    this.retainedFindings.push(finding);
  }

  private ensureUsable(): void {
    if (this.disposed) throw new RunCheckpointStoreDisposedError();
  }

  private filePath(checkpointId: string): string {
    return join(this.rootDir, `${checkpointFileHash(checkpointId)}.json`);
  }
}

function normalizeCheckpointId(value: unknown): string {
  if (typeof value !== 'string') throw new RunCheckpointValidationError('checkpointId must be a string.');
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new RunCheckpointValidationError('checkpointId is empty or too long.');
  }
  return normalized;
}

function boundedDiagnostics(entries: RunCheckpointDiagnostic[]): RunCheckpointDiagnostic[] {
  const bounded = entries.length > MAX_DIAGNOSTICS ? entries.slice(entries.length - MAX_DIAGNOSTICS) : entries;
  return bounded.map((entry) => ({ ...entry }));
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value as number));
}
