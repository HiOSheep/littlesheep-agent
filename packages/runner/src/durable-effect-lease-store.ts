// Durable cross-process ownership for one effectful tool invocation.
// Effect identities are hashed before they reach the reusable run-lease store,
// so its files never contain tool arguments, resource paths, or raw effect ids.
import { createHash } from 'node:crypto';
import {
  DurableRunLeaseStore,
  type DurableRunLease,
  type DurableRunLeaseStoreOptions,
} from './durable-run-lease-store.js';

export interface DurableEffectLeaseIdentity {
  sessionId: string;
  runId: string;
  effectId: string;
}

export interface DurableEffectLease {
  effectKey: string;
  status: DurableRunLease['status'];
  ownerToken?: string;
  leaseUntil?: string;
  attempts: number;
}

export type DurableEffectLeaseAcquireOutcome =
  | { kind: 'acquired' | 'reclaimed'; lease: DurableEffectLease }
  | { kind: 'conflict'; lease: DurableEffectLease };

export type DurableEffectLeaseStoreOptions = DurableRunLeaseStoreOptions;

export class DurableEffectLeaseStore {
  private readonly leases: DurableRunLeaseStore;

  constructor(options: DurableEffectLeaseStoreOptions) {
    this.leases = new DurableRunLeaseStore(options);
  }

  initialize(): Promise<void> {
    return this.leases.initialize();
  }

  async acquire(identity: DurableEffectLeaseIdentity): Promise<DurableEffectLeaseAcquireOutcome> {
    const key = effectKey(identity);
    const outcome = await this.leases.acquire(normalize(identity.sessionId, 'sessionId'), `effect-${key}`);
    return { kind: outcome.kind, lease: projectLease(key, outcome.lease) };
  }

  async renew(identity: DurableEffectLeaseIdentity, ownerToken: string): Promise<DurableEffectLease> {
    const key = effectKey(identity);
    return projectLease(key, await this.leases.renew(
      normalize(identity.sessionId, 'sessionId'),
      `effect-${key}`,
      ownerToken,
    ));
  }

  async release(identity: DurableEffectLeaseIdentity, ownerToken: string): Promise<DurableEffectLease> {
    const key = effectKey(identity);
    return projectLease(key, await this.leases.release(
      normalize(identity.sessionId, 'sessionId'),
      `effect-${key}`,
      ownerToken,
    ));
  }

  async read(identity: DurableEffectLeaseIdentity): Promise<DurableEffectLease | null> {
    const key = effectKey(identity);
    const lease = await this.leases.read(normalize(identity.sessionId, 'sessionId'), `effect-${key}`);
    return lease ? projectLease(key, lease) : null;
  }
}

function effectKey(identity: DurableEffectLeaseIdentity): string {
  const sessionId = normalize(identity.sessionId, 'sessionId');
  const runId = normalize(identity.runId, 'runId');
  const effectId = normalize(identity.effectId, 'effectId');
  return createHash('sha256')
    .update(`${sessionId.length}:${sessionId}${runId.length}:${runId}${effectId.length}:${effectId}`, 'utf8')
    .digest('hex');
}

function normalize(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty`);
  const normalized = value.trim();
  if (normalized.length > 2_048) throw new Error(`${label} exceeds 2048 characters`);
  return normalized;
}

function projectLease(effectKeyValue: string, lease: DurableRunLease): DurableEffectLease {
  return {
    effectKey: effectKeyValue,
    status: lease.status,
    ...(lease.ownerToken ? { ownerToken: lease.ownerToken } : {}),
    ...(lease.leaseUntil ? { leaseUntil: lease.leaseUntil } : {}),
    attempts: lease.attempts,
  };
}
