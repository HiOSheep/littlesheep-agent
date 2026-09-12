// Per-run renewal driver for effect leases. The Harness sees only a digest of
// the owner token; raw fencing tokens remain inside the Runner boundary.
import { createHash } from 'node:crypto';
import type { EffectLeaseAcquireOutcome, EffectLeaseCoordinatorLike } from '@littlesheep/types';
import {
  DurableEffectLeaseStore,
  type DurableEffectLease,
  type DurableEffectLeaseIdentity,
} from './durable-effect-lease-store.js';

const MIN_RENEW_DELAY_MS = 250;

export interface DurableEffectLeaseCoordinatorOptions {
  store: DurableEffectLeaseStore;
  sessionId: string;
  runId: string;
  onOwnershipLost: (error: Error) => void;
}

interface ActiveEffectLease {
  identity: DurableEffectLeaseIdentity;
  lease: DurableEffectLease;
  timer?: NodeJS.Timeout;
}

export class DurableEffectLeaseCoordinator implements EffectLeaseCoordinatorLike {
  private readonly active = new Map<string, ActiveEffectLease>();
  private closed = false;

  constructor(private readonly options: DurableEffectLeaseCoordinatorOptions) {}

  async acquire(effectId: string): Promise<EffectLeaseAcquireOutcome> {
    if (this.closed) throw new Error('effect lease coordinator is closed');
    const identity = this.identity(effectId);
    const outcome = await this.options.store.acquire(identity);
    if (outcome.kind === 'conflict') {
      return { kind: 'conflict', ...(outcome.lease.leaseUntil ? { leaseUntil: outcome.lease.leaseUntil } : {}) };
    }
    if (!outcome.lease.ownerToken || !outcome.lease.leaseUntil) {
      throw new Error('acquired effect lease is missing ownership fields');
    }
    const entry: ActiveEffectLease = { identity, lease: outcome.lease };
    this.active.set(effectId, entry);
    this.schedule(effectId, entry);
    return {
      kind: 'acquired',
      ownerId: ownerId(outcome.lease.ownerToken),
      leaseUntil: outcome.lease.leaseUntil,
    };
  }

  async release(effectId: string): Promise<void> {
    const entry = this.active.get(effectId);
    if (!entry) return;
    this.active.delete(effectId);
    if (entry.timer) clearTimeout(entry.timer);
    const ownerToken = entry.lease.ownerToken;
    if (ownerToken) await this.options.store.release(entry.identity, ownerToken);
  }

  async confirm(effectId: string): Promise<{ ownerId: string; leaseUntil: string }> {
    const entry = this.active.get(effectId);
    if (!entry?.lease.ownerToken) throw new Error(`effect lease is no longer owned: ${effectId}`);
    entry.lease = await this.options.store.renew(entry.identity, entry.lease.ownerToken);
    const ownerToken = entry.lease.ownerToken;
    if (!ownerToken || !entry.lease.leaseUntil) throw new Error(`effect lease renewal has no ownership fields: ${effectId}`);
    if (entry.timer) clearTimeout(entry.timer);
    this.schedule(effectId, entry);
    return { ownerId: ownerId(ownerToken), leaseUntil: entry.lease.leaseUntil };
  }

  async releaseAll(): Promise<void> {
    this.closed = true;
    const effectIds = [...this.active.keys()];
    const results = await Promise.allSettled(effectIds.map((effectId) => this.release(effectId)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  private identity(effectId: string): DurableEffectLeaseIdentity {
    return { sessionId: this.options.sessionId, runId: this.options.runId, effectId };
  }

  private schedule(effectId: string, entry: ActiveEffectLease): void {
    if (this.closed || !entry.lease.leaseUntil) return;
    const remainingMs = Date.parse(entry.lease.leaseUntil) - Date.now();
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.renew(effectId, entry);
    }, Math.max(MIN_RENEW_DELAY_MS, Math.floor(remainingMs / 2)));
    entry.timer.unref?.();
  }

  private async renew(effectId: string, entry: ActiveEffectLease): Promise<void> {
    if (this.closed || this.active.get(effectId) !== entry || !entry.lease.ownerToken) return;
    try {
      entry.lease = await this.options.store.renew(entry.identity, entry.lease.ownerToken);
      this.schedule(effectId, entry);
    } catch (error) {
      this.active.delete(effectId);
      this.options.onOwnershipLost(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function ownerId(ownerToken: string): string {
  return createHash('sha256').update(ownerToken, 'utf8').digest('hex');
}
