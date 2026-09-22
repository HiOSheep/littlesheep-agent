// Cross-process ownership leases for long-running durable runs.
// Inbox claims protect command materialization; these leases protect the
// model/tool lifecycle that continues after ingress commands are completed.
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from '@littlesheep/session';
import {
  asRecord,
  boundedInteger,
  hashParts,
  isAtomicWriteTempFile,
  normalizeIdentifier,
  normalizeTime,
  parseJson,
  randomId,
  writeJsonAtomically,
} from './durable-store-utils.js';

export const DURABLE_RUN_LEASE_VERSION = 1 as const;
export const DEFAULT_DURABLE_RUN_LEASE_MS = 30_000;
export const MAX_DURABLE_RUN_LEASE_MS = 60 * 60 * 1_000;
const MIN_DURABLE_RUN_LEASE_MS = 1_000;
const DEFAULT_LIST_LIMIT = 256;
const MAX_LIST_LIMIT = 1_024;
const LEASE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;

export interface DurableRunLease {
  readonly version: typeof DURABLE_RUN_LEASE_VERSION;
  readonly sessionId: string;
  readonly runId: string;
  readonly status: 'active' | 'released';
  readonly ownerToken?: string;
  readonly createdAt: string;
  readonly acquiredAt: string;
  readonly updatedAt: string;
  readonly leaseUntil?: string;
  readonly releasedAt?: string;
  readonly attempts: number;
}

export type DurableRunLeaseAcquireOutcome =
  | { readonly kind: 'acquired' | 'reclaimed'; readonly lease: DurableRunLease }
  | { readonly kind: 'conflict'; readonly lease: DurableRunLease };

export interface DurableRunLeaseStoreOptions {
  rootDir: string;
  leaseMs?: number;
  now?: () => Date;
}

export class DurableRunLeaseStore {
  private readonly rootDir: string;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private initializationFailure: Error | undefined;

  constructor(options: DurableRunLeaseStoreOptions) {
    const rootDir = options.rootDir.trim();
    if (!rootDir) throw new Error('durable run lease rootDir must be non-empty');
    this.rootDir = rootDir;
    this.leaseMs = boundedInteger(
      options.leaseMs,
      DEFAULT_DURABLE_RUN_LEASE_MS,
      MIN_DURABLE_RUN_LEASE_MS,
      MAX_DURABLE_RUN_LEASE_MS,
    );
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializationFailure) throw this.initializationFailure;
    try {
      await mkdir(this.rootDir, { recursive: true });
      await this.withWriteLock(() => this.readLeases().then(() => undefined));
      this.initialized = true;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.initializationFailure = normalized;
      throw normalized;
    }
  }

  async acquire(sessionId: string, runId: string): Promise<DurableRunLeaseAcquireOutcome> {
    const identity = normalizeLeaseIdentity(sessionId, runId);
    return this.withWriteLock(async () => {
      const existing = await this.readOptional(identity.sessionId, identity.runId);
      const now = this.now();
      if (existing?.status === 'active' && isLeaseActive(existing, now)) {
        return { kind: 'conflict', lease: cloneLease(existing) };
      }
      const timestamp = now.toISOString();
      const lease: DurableRunLease = {
        version: DURABLE_RUN_LEASE_VERSION,
        ...identity,
        status: 'active',
        ownerToken: randomId(),
        createdAt: existing?.createdAt ?? timestamp,
        acquiredAt: timestamp,
        updatedAt: timestamp,
        leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString(),
        attempts: (existing?.attempts ?? 0) + 1,
      };
      await this.writeLease(lease);
      return {
        kind: existing ? 'reclaimed' : 'acquired',
        lease: cloneLease(lease),
      };
    });
  }

  async renew(sessionId: string, runId: string, ownerToken: string): Promise<DurableRunLease> {
    const identity = normalizeLeaseIdentity(sessionId, runId);
    const normalizedOwner = normalizeIdentifier(ownerToken, 'ownerToken');
    return this.withWriteLock(async () => {
      const lease = await this.readRequired(identity.sessionId, identity.runId);
      const now = this.now();
      assertActiveOwner(lease, normalizedOwner);
      if (!isLeaseActive(lease, now)) {
        throw new DurableRunLeaseError(`run lease expired: ${identity.runId}`, 'expired');
      }
      const updated: DurableRunLease = {
        ...lease,
        updatedAt: now.toISOString(),
        leaseUntil: new Date(now.getTime() + this.leaseMs).toISOString(),
      };
      await this.writeLease(updated);
      return cloneLease(updated);
    });
  }

  async release(sessionId: string, runId: string, ownerToken: string): Promise<DurableRunLease> {
    const identity = normalizeLeaseIdentity(sessionId, runId);
    const normalizedOwner = normalizeIdentifier(ownerToken, 'ownerToken');
    return this.withWriteLock(async () => {
      const lease = await this.readRequired(identity.sessionId, identity.runId);
      if (lease.status === 'released') return cloneLease(lease);
      assertActiveOwner(lease, normalizedOwner);
      const timestamp = this.now().toISOString();
      const updated: DurableRunLease = {
        ...lease,
        status: 'released',
        ownerToken: undefined,
        leaseUntil: undefined,
        updatedAt: timestamp,
        releasedAt: timestamp,
      };
      await this.writeLease(updated);
      return cloneLease(updated);
    });
  }

  async read(sessionId: string, runId: string): Promise<DurableRunLease | null> {
    const identity = normalizeLeaseIdentity(sessionId, runId);
    return this.readOptional(identity.sessionId, identity.runId).then((lease) => lease ? cloneLease(lease) : null);
  }

  async listActiveRuns(limit = DEFAULT_LIST_LIMIT): Promise<Array<{ sessionId: string; runId: string }>> {
    return this.listRunsByAvailability('active', limit);
  }

  async listRecoverableRuns(limit = DEFAULT_LIST_LIMIT): Promise<Array<{ sessionId: string; runId: string }>> {
    return this.listRunsByAvailability('expired', limit);
  }

  async nextLeaseExpiry(): Promise<string | undefined> {
    return this.withWriteLock(async () => {
      const now = this.now();
      let earliest: string | undefined;
      for (const lease of await this.readLeases()) {
        if (lease.status !== 'active' || !lease.leaseUntil || !isLeaseActive(lease, now)) continue;
        if (earliest === undefined || lease.leaseUntil < earliest) earliest = lease.leaseUntil;
      }
      return earliest;
    });
  }

  private async listRunsByAvailability(
    availability: 'active' | 'expired',
    limit: number,
  ): Promise<Array<{ sessionId: string; runId: string }>> {
    const boundedLimit = boundedInteger(limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    return this.withWriteLock(async () => {
      const now = this.now();
      const matches = (await this.readLeases()).filter((lease) => (
        lease.status === 'active'
        && (availability === 'active' ? isLeaseActive(lease, now) : !isLeaseActive(lease, now))
      ));
      if (matches.length > boundedLimit) {
        throw new DurableRunLeaseError(`${availability} run lease count exceeds ${boundedLimit}`, 'state');
      }
      return matches
        .sort((left, right) => left.acquiredAt.localeCompare(right.acquiredAt)
          || left.sessionId.localeCompare(right.sessionId)
          || left.runId.localeCompare(right.runId))
        .map(({ sessionId, runId }) => ({ sessionId, runId }));
    });
  }

  private async readOptional(sessionId: string, runId: string): Promise<DurableRunLease | null> {
    try {
      return await this.readRequired(sessionId, runId);
    } catch (error) {
      if (error instanceof DurableRunLeaseError && error.kind === 'missing') return null;
      throw error;
    }
  }

  private async readRequired(sessionId: string, runId: string): Promise<DurableRunLease> {
    const file = this.filePath(sessionId, runId);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DurableRunLeaseError(`run lease not found: ${runId}`, 'missing');
      }
      throw error;
    }
    return validateLease(parseJson(raw, file), { sessionId, runId });
  }

  private async readLeases(): Promise<DurableRunLease[]> {
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name === '.run-leases.lock') continue;
      // A concurrent writer may be mid-rename; its temp file is not an
      // authoritative lease. Unknown names still fail closed.
      if (isAtomicWriteTempFile(entry.name)) continue;
      if (!LEASE_FILE_PATTERN.test(entry.name)) {
        throw new DurableRunLeaseError(`unexpected run lease file: ${entry.name}`, 'corrupt');
      }
    }
    const leases: DurableRunLease[] = [];
    for (const entry of entries.filter((item) => item.isFile() && LEASE_FILE_PATTERN.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(this.rootDir, entry.name);
      const lease = validateLease(parseJson(await readFile(file, 'utf8'), file));
      if (`${hashParts(lease.sessionId, lease.runId)}.json` !== entry.name) {
        throw new DurableRunLeaseError(`run lease identity/file mismatch: ${entry.name}`, 'corrupt');
      }
      leases.push(lease);
    }
    return leases;
  }

  private writeLease(lease: DurableRunLease): Promise<void> {
    return writeJsonAtomically(this.filePath(lease.sessionId, lease.runId), lease);
  }

  private filePath(sessionId: string, runId: string): string {
    return join(this.rootDir, `${hashParts(sessionId, runId)}.json`);
  }

  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.writeTail.catch(() => undefined).then(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const lock = await acquireLock(join(this.rootDir, '.run-leases'), 60_000);
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

export class DurableRunLeaseError extends Error {
  constructor(message: string, readonly kind: 'missing' | 'corrupt' | 'conflict' | 'expired' | 'state') {
    super(message);
    this.name = 'DurableRunLeaseError';
  }
}

function normalizeLeaseIdentity(sessionId: string, runId: string): { sessionId: string; runId: string } {
  return {
    sessionId: normalizeIdentifier(sessionId, 'sessionId'),
    runId: normalizeIdentifier(runId, 'runId'),
  };
}

function validateLease(
  value: unknown,
  expected?: { sessionId: string; runId: string },
): DurableRunLease {
  const record = asRecord(value, 'durable run lease');
  if (record.version !== DURABLE_RUN_LEASE_VERSION) {
    throw new DurableRunLeaseError(`unknown durable run lease version: ${String(record.version)}`, 'corrupt');
  }
  const sessionId = normalizeIdentifier(record.sessionId, 'sessionId');
  const runId = normalizeIdentifier(record.runId, 'runId');
  if (expected && (sessionId !== expected.sessionId || runId !== expected.runId)) {
    throw new DurableRunLeaseError('run lease identity mismatch', 'corrupt');
  }
  if (record.status !== 'active' && record.status !== 'released') {
    throw new DurableRunLeaseError(`invalid run lease status: ${String(record.status)}`, 'corrupt');
  }
  const ownerToken = record.ownerToken === undefined ? undefined : normalizeIdentifier(record.ownerToken, 'ownerToken');
  const leaseUntil = record.leaseUntil === undefined ? undefined : normalizeTime(record.leaseUntil, 'leaseUntil');
  if (record.status === 'active' && (!ownerToken || !leaseUntil)) {
    throw new DurableRunLeaseError('active run lease requires ownerToken and leaseUntil', 'corrupt');
  }
  if (record.status === 'released' && (ownerToken || leaseUntil)) {
    throw new DurableRunLeaseError('released run lease cannot retain ownerToken or leaseUntil', 'corrupt');
  }
  if (!Number.isSafeInteger(record.attempts) || (record.attempts as number) < 1) {
    throw new DurableRunLeaseError('invalid run lease attempts', 'corrupt');
  }
  const createdAt = normalizeTime(record.createdAt, 'createdAt');
  const acquiredAt = normalizeTime(record.acquiredAt, 'acquiredAt');
  const updatedAt = normalizeTime(record.updatedAt, 'updatedAt');
  const releasedAt = record.releasedAt === undefined ? undefined : normalizeTime(record.releasedAt, 'releasedAt');
  if (record.status === 'released' && !releasedAt) {
    throw new DurableRunLeaseError('released run lease requires releasedAt', 'corrupt');
  }
  return {
    version: DURABLE_RUN_LEASE_VERSION,
    sessionId,
    runId,
    status: record.status,
    ...(ownerToken ? { ownerToken } : {}),
    createdAt,
    acquiredAt,
    updatedAt,
    ...(leaseUntil ? { leaseUntil } : {}),
    ...(releasedAt ? { releasedAt } : {}),
    attempts: record.attempts as number,
  };
}

function assertActiveOwner(lease: DurableRunLease, ownerToken: string): void {
  if (lease.status !== 'active') throw new DurableRunLeaseError(`run lease is not active: ${lease.runId}`, 'state');
  if (lease.ownerToken !== ownerToken) {
    throw new DurableRunLeaseError(`run lease ownership changed: ${lease.runId}`, 'conflict');
  }
}

function isLeaseActive(lease: DurableRunLease, now: Date): boolean {
  return lease.status === 'active'
    && lease.leaseUntil !== undefined
    && Date.parse(lease.leaseUntil) > now.getTime();
}

function cloneLease(lease: DurableRunLease): DurableRunLease {
  return JSON.parse(JSON.stringify(lease)) as DurableRunLease;
}
