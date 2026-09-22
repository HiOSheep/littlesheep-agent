// @littlesheep/tools — file-observation.ts
//
// The host half of "the model may only overwrite what it actually read".
//
// A read records the raw bytes it delivered; a write compares those bytes with
// the file it is about to replace. This module holds the bounded in-memory
// bookkeeping and the canonical-path keying, and nothing else: it never reads or
// writes user files, and it never decides *what* a caller may do with a result.
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  FileObservationFailureKind,
  FileObservationLookup,
  FileObservationPort,
  FileObservationSnapshot,
} from '@littlesheep/types';

/** sha256 hex digest of the exact bytes a read delivered. */
export function hashFileBytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type ObservationKeyResult =
  | { ok: true; key: string }
  | { ok: false; errorKind: Extract<FileObservationFailureKind, 'observation_unsupported'>; message: string };

/**
 * Canonical identity for one observable file.
 *
 * The key must be identical for the read and the later write, so it is built
 * from the resolved real path with Windows case folding. Links and non-regular
 * files are refused on purpose: their revision cannot be pinned to the bytes the
 * model saw, so v1 declines to authorize a mutation instead of guessing.
 */
export function observationKeyFor(absPath: string): ObservationKeyResult {
  const absolute = resolve(absPath);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch (error) {
    return {
      ok: false,
      errorKind: 'observation_unsupported',
      message: `cannot observe ${absolute}: ${(error as Error).message}`,
    };
  }
  if (stats.isSymbolicLink()) {
    return {
      ok: false,
      errorKind: 'observation_unsupported',
      message: `${absolute} is a symbolic link; read and edit the resolved path instead`,
    };
  }
  if (!stats.isFile()) {
    return {
      ok: false,
      errorKind: 'observation_unsupported',
      message: `${absolute} is not a regular file`,
    };
  }
  let real = absolute;
  try {
    real = realpathSync.native(absolute);
  } catch {
    real = absolute;
  }
  return { ok: true, key: process.platform === 'win32' ? real.toLowerCase() : real };
}

/** Serializes work for one canonical key inside a single host process. */
export interface PathMutexTable {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createPathMutexTable(): PathMutexTable {
  // One promise chain per canonical path. The chain itself never rejects, so a
  // failed write cannot poison the next waiter, and the entry is dropped once
  // the last waiter finishes so the map stays bounded.
  const tails = new Map<string, Promise<unknown>>();
  return {
    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      const run = previous.then(fn, fn);
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      try {
        return await run;
      } finally {
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}

export interface FileObservationTableOptions {
  /** Shared across the session tables of one host so cross-session writes serialize. */
  mutex?: PathMutexTable;
  /** Bounded entry count; the oldest observation is evicted first. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 512;

/**
 * One session's observation table. Bounded, in-memory, and never persisted: an
 * evicted or restarted entry simply means the model has to read the file again.
 */
export function createFileObservationTable(
  options: FileObservationTableOptions = {},
): FileObservationPort {
  const mutex = options.mutex ?? createPathMutexTable();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, FileObservationSnapshot>();
  let suspensions = 0;

  const remove = (key: string): void => {
    entries.delete(key);
  };

  return {
    recordRead({ absPath, snapshot }): void {
      // While an opaque mutation may be running, a read cannot testify about a
      // version: the command may be rewriting the file at this very moment.
      if (suspensions > 0) return;
      const key = observationKeyFor(absPath);
      if (!key.ok) return;
      entries.delete(key.key);
      entries.set(key.key, snapshot);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },

    lookup(absPath): FileObservationLookup {
      if (suspensions > 0) {
        return {
          ok: false,
          errorKind: 'observation_suspended',
          message: 'a command may have changed files; read the file again before overwriting it',
        };
      }
      const key = observationKeyFor(absPath);
      if (!key.ok) return { ok: false, errorKind: key.errorKind, message: key.message };
      const snapshot = entries.get(key.key);
      if (!snapshot) {
        return {
          ok: false,
          errorKind: 'observation_missing',
          message: `no observation for ${absPath}; read the file before overwriting it`,
        };
      }
      return { ok: true, snapshot };
    },

    invalidate(absPath): void {
      const key = observationKeyFor(absPath);
      if (key.ok) remove(key.key);
    },

    invalidateAll(): void {
      entries.clear();
    },

    suspend(): () => void {
      suspensions += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        suspensions = Math.max(0, suspensions - 1);
      };
    },

    withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
      const key = observationKeyFor(absPath);
      return mutex.withLock(key.ok ? key.key : resolve(absPath), fn);
    },
  };
}

/**
 * Standalone port for hosts and tests that do not need the Runner's shared
 * session registry. It performs the real bookkeeping (no check is disabled);
 * only the cross-session mutex is private to this instance.
 */
export function createInMemoryFileObservationPort(
  options: FileObservationTableOptions = {},
): FileObservationPort {
  return createFileObservationTable(options);
}
/** Convenience snapshot builder so callers do not hand-write the shape. */
export function observationSnapshot(input: {
  version: string;
  sizeBytes: number;
  mtimeMs: number;
  coverage: 'full' | 'partial';
  visibleLineRange?: { start: number; end: number };
  runId: string;
  observedAt?: string;
}): FileObservationSnapshot {
  return {
    version: input.version,
    sizeBytes: input.sizeBytes,
    mtimeMs: input.mtimeMs,
    coverage: input.coverage,
    ...(input.visibleLineRange ? { visibleLineRange: input.visibleLineRange } : {}),
    observedAt: input.observedAt ?? new Date().toISOString(),
    runId: input.runId,
  };
}
