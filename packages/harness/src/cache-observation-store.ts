// Durable, scope-authorized storage for redacted cache observations.
// It never stores prompt text, tool arguments, provider payloads or evidence.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWrite } from '@littlesheep/memory-core';
import type { CacheObservation } from '@littlesheep/types';
import {
  authorizeCacheObservationScope,
  buildCacheScopePartition,
  type CacheScopeInput,
} from './cache-observability.js';
import { buildCacheQualityReport, type CacheQualityReport } from './cache-quality-report.js';
import type { ModelRequestLatencySummary } from './model-latency-report.js';
import { readCacheObservation } from './durable-projection-codec.js';

const ENTRY_VERSION = 1 as const;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_ENTRIES = 4_096;

export interface CacheObservationStoreOptions {
  rootDir: string;
  maxAgeMs?: number;
  now?: () => number;
}

export interface CacheObservationLookupInput extends CacheScopeInput {
  /** Usually the normalized-request HMAC from the request-bound observation. */
  entryFingerprint: string;
}

export type CacheObservationLookupResult =
  | { readonly status: 'hit'; readonly observation: CacheObservation }
  | { readonly status: 'miss'; readonly reason: 'not_found' | 'expired' }
  | { readonly status: 'unavailable' | 'unknown'; readonly reason: string };

export type CacheObservationStoreResult =
  | { readonly stored: true }
  | { readonly stored: false; readonly reason: string };

export type CacheObservationReportResult =
  | { readonly status: 'available'; readonly report: CacheQualityReport }
  | { readonly status: 'unavailable'; readonly reason: string };

interface PersistedCacheObservation {
  version: typeof ENTRY_VERSION;
  storedAt: number;
  scopeDigest: string;
  entryFingerprint: string;
  observation: CacheObservation;
}

/**
 * A small append-by-replacement observation store. Scope is part of the file
 * identity and is re-authorized against the caller before any hit is returned.
 */
export class CacheObservationStore {
  readonly rootDir: string;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: CacheObservationStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.maxAgeMs = normalizeMaxAge(options.maxAgeMs);
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await this.prune();
  }

  async lookup(input: CacheObservationLookupInput): Promise<CacheObservationLookupResult> {
    const scope = authorizeLookupScope(input);
    if (!scope.allowed) return { status: 'unavailable', reason: `scope_${scope.reason}` };
    const entryFingerprint = normalizeFingerprint(input.entryFingerprint);
    if (!entryFingerprint) return { status: 'unknown', reason: 'entry_fingerprint_invalid' };
    const path = this.entryPath(scope.partitionDigest, entryFingerprint);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { status: 'miss', reason: 'not_found' };
      return { status: 'unavailable', reason: 'cache_read_failed' };
    }
    let entry: PersistedCacheObservation;
    try {
      entry = parseEntry(raw);
    } catch {
      return { status: 'unknown', reason: 'cache_entry_invalid' };
    }
    if (this.now() - entry.storedAt > this.maxAgeMs) {
      await unlink(path).catch(() => undefined);
      return { status: 'miss', reason: 'expired' };
    }
    if (entry.scopeDigest !== scope.partitionDigest || entry.entryFingerprint !== entryFingerprint) {
      return { status: 'unavailable', reason: 'cache_entry_scope_mismatch' };
    }
    const observationScope = authorizeCacheObservationScope(entry.observation, input);
    if (!observationScope.allowed) return { status: 'unavailable', reason: `scope_${observationScope.reason}` };
    if (entry.observation.normalizedRequest.fingerprint !== entryFingerprint) {
      return { status: 'unknown', reason: 'cache_entry_fingerprint_mismatch' };
    }
    return { status: 'hit', observation: structuredClone(entry.observation) };
  }

  async put(observation: CacheObservation, input: CacheScopeInput): Promise<CacheObservationStoreResult> {
    const scope = authorizeLookupScope(input);
    if (!scope.allowed) return { stored: false, reason: `scope_${scope.reason}` };
    let normalizedObservation: CacheObservation;
    try {
      normalizedObservation = readCacheObservation(observation);
    } catch {
      return { stored: false, reason: 'cache_observation_invalid' };
    }
    const authorized = authorizeCacheObservationScope(normalizedObservation, input);
    if (!authorized.allowed) return { stored: false, reason: `scope_${authorized.reason}` };
    const entryFingerprint = normalizeFingerprint(normalizedObservation.normalizedRequest.fingerprint);
    if (!entryFingerprint) return { stored: false, reason: 'entry_fingerprint_invalid' };
    const entry: PersistedCacheObservation = {
      version: ENTRY_VERSION,
      storedAt: this.now(),
      scopeDigest: scope.partitionDigest,
      entryFingerprint,
      observation: structuredClone(normalizedObservation),
    };
    const serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ENTRY_BYTES) {
      return { stored: false, reason: 'cache_entry_too_large' };
    }
    return this.enqueueWrite(async () => {
      await mkdir(this.rootDir, { recursive: true });
      await atomicWrite(this.entryPath(scope.partitionDigest, entryFingerprint), serialized);
      await this.prune();
    });
  }

  async clear(): Promise<void> {
    await this.enqueueWrite(async () => {
      const files = await readdir(this.rootDir).catch(() => [] as string[]);
      await Promise.all(files
        .filter((file) => file.endsWith('.json'))
        .map((file) => unlink(join(this.rootDir, file)).catch(() => undefined)));
    });
  }

  /** Return the most recent authorized observation for a scope, if any. */
  async latest(input: CacheScopeInput): Promise<CacheObservation | undefined> {
    const scope = authorizeLookupScope(input);
    if (!scope.allowed) return undefined;

    const files = await readdir(this.rootDir).catch(() => [] as string[]);
    let best: PersistedCacheObservation | undefined;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const path = join(this.rootDir, file);
      let entry: PersistedCacheObservation;
      try {
        entry = parseEntry(await readFile(path, 'utf8'));
      } catch {
        continue;
      }
      if (entry.scopeDigest !== scope.partitionDigest) continue;
      if (this.now() - entry.storedAt > this.maxAgeMs) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (!authorizeCacheObservationScope(entry.observation, input).allowed) continue;
      if (!best || entry.storedAt > best.storedAt) best = entry;
    }
    return best ? structuredClone(best.observation) : undefined;
  }

  /**
   * Build a scope-authorized CACHE-09/10 report over stored observations.
   * Cross-scope entries are never returned; corrupt or tampered entries only
   * degrade the report gate and are never treated as cache hits.
   */
  async report(
    input: CacheScopeInput & {
      readonly latency?: ModelRequestLatencySummary;
      readonly since?: number;
      readonly until?: number;
    },
  ): Promise<CacheObservationReportResult> {
    const scope = authorizeLookupScope(input);
    if (!scope.allowed) return { status: 'unavailable', reason: `scope_${scope.reason}` };
    if (!validWindow(input.since, input.until)) {
      return { status: 'unavailable', reason: 'report_window_invalid' };
    }

    const files = await readdir(this.rootDir).catch(() => [] as string[]);
    const observations: CacheObservation[] = [];
    let unreadableEntryCount = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const path = join(this.rootDir, file);
      let entry: PersistedCacheObservation;
      try {
        entry = parseEntry(await readFile(path, 'utf8'));
      } catch {
        unreadableEntryCount += 1;
        continue;
      }
      if (entry.scopeDigest !== scope.partitionDigest) continue;
      if (this.now() - entry.storedAt > this.maxAgeMs) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (input.since !== undefined && entry.storedAt < input.since) continue;
      if (input.until !== undefined && entry.storedAt > input.until) continue;
      const authorized = authorizeCacheObservationScope(entry.observation, input);
      if (!authorized.allowed) {
        unreadableEntryCount += 1;
        continue;
      }
      observations.push(entry.observation);
    }

    observations.sort((left, right) => (
      left.requestIndex - right.requestIndex
      || left.modelRequestId.localeCompare(right.modelRequestId)
    ));
    return {
      status: 'available',
      report: buildCacheQualityReport({
        observations,
        ...(input.latency ? { latency: input.latency } : {}),
        unreadableEntryCount,
      }),
    };
  }

  private async prune(): Promise<void> {
    const files = await readdir(this.rootDir).catch(() => [] as string[]);
    const candidates = files.filter((file) => file.endsWith('.json'));
    const now = this.now();
    const entries: Array<{ file: string; storedAt: number }> = [];
    for (const file of candidates) {
      const path = join(this.rootDir, file);
      try {
        const entry = parseEntry(await readFile(path, 'utf8'));
        if (now - entry.storedAt > this.maxAgeMs) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        entries.push({ file, storedAt: entry.storedAt });
      } catch {
        await unlink(path).catch(() => undefined);
      }
    }
    if (entries.length <= MAX_ENTRIES) return;
    entries.sort((left, right) => left.storedAt - right.storedAt || left.file.localeCompare(right.file));
    await Promise.all(entries.slice(0, entries.length - MAX_ENTRIES).map((entry) => (
      unlink(join(this.rootDir, entry.file)).catch(() => undefined)
    )));
  }

  private entryPath(scopeDigest: string, entryFingerprint: string): string {
    const file = createHash('sha256')
      .update(`${scopeDigest}\0${entryFingerprint}`, 'utf8')
      .digest('hex');
    return join(this.rootDir, `${file}.json`);
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<CacheObservationStoreResult> {
    const current = this.writeTail.catch(() => undefined).then(operation);
    this.writeTail = current.then(() => undefined, () => undefined);
    return current.then(
      () => ({ stored: true as const }),
      () => ({ stored: false as const, reason: 'cache_write_failed' }),
    );
  }
}

function authorizeLookupScope(input: CacheScopeInput):
  | { readonly allowed: true; readonly partitionDigest: string }
  | { readonly allowed: false; readonly reason: string } {
  if (!input.sessionId.trim() || !input.workspaceScope.trim() || !input.permissionPolicyId) {
    return { allowed: false, reason: 'scope_unavailable' };
  }
  if (input.key === undefined || input.key === null || input.key.length === 0) {
    return { allowed: false, reason: 'key_unavailable' };
  }
  const scope = buildCacheScopePartition(input);
  if (scope.keySource !== 'provided' || !scope.partitionDigest) {
    return { allowed: false, reason: 'key_unavailable' };
  }
  return { allowed: true, partitionDigest: scope.partitionDigest };
}

function parseEntry(raw: string): PersistedCacheObservation {
  const value = JSON.parse(raw) as Partial<PersistedCacheObservation> & Record<string, unknown>;
  if (value.version !== ENTRY_VERSION
    || !Number.isSafeInteger(value.storedAt)
    || typeof value.scopeDigest !== 'string'
    || typeof value.entryFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.scopeDigest)
    || !/^[a-f0-9]{64}$/u.test(value.entryFingerprint)
    || !value.observation
    || typeof value.observation !== 'object'
    || typeof (value.observation as CacheObservation).normalizedRequest !== 'object') {
    throw new Error('invalid cache observation entry');
  }
  const allowed = new Set(['version', 'storedAt', 'scopeDigest', 'entryFingerprint', 'observation']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('invalid cache observation entry keys');
  return {
    version: ENTRY_VERSION,
    storedAt: value.storedAt as number,
    scopeDigest: value.scopeDigest as string,
    entryFingerprint: value.entryFingerprint as string,
    observation: readCacheObservation(value.observation),
  };
}

function normalizeFingerprint(value: string | undefined): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function normalizeMaxAge(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.min(value, 30 * 24 * 60 * 60 * 1_000)
    : DEFAULT_MAX_AGE_MS;
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === code);
}

function validWindow(since: number | undefined, until: number | undefined): boolean {
  for (const value of [since, until]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) return false;
  }
  return since === undefined || until === undefined || since <= until;
}
