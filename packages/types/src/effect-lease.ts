// Runtime adapter contract for cross-process ownership of effectful tool work.
export type EffectLeaseAcquireOutcome =
  | { kind: 'acquired'; ownerId: string; leaseUntil: string }
  | { kind: 'conflict'; leaseUntil?: string };

/** Harness never receives or persists the raw fencing token. */
export interface EffectLeaseCoordinatorLike {
  acquire(effectId: string): Promise<EffectLeaseAcquireOutcome>;
  /** Renew immediately before settlement, proving the original fence still owns the effect. */
  confirm(effectId: string): Promise<{ ownerId: string; leaseUntil: string }>;
  release(effectId: string): Promise<void>;
}
