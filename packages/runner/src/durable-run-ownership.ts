// One Runner-owned facade for run and effect lease lifecycles.
import type { EffectLeaseCoordinatorLike } from '@littlesheep/types';
import { DurableEffectLeaseCoordinator } from './durable-effect-lease-coordinator.js';
import type { DurableEffectLeaseStore } from './durable-effect-lease-store.js';
import { DurableRunLeaseHeartbeat } from './durable-run-lease-heartbeat.js';
import type { DurableRunLeaseStore } from './durable-run-lease-store.js';

export interface DurableRunOwnershipOptions {
  runStore: DurableRunLeaseStore;
  effectStore: DurableEffectLeaseStore;
  sessionId: string;
  runId: string;
  onOwnershipLost: (kind: 'run' | 'effect', error: Error) => void;
}

export class DurableRunOwnership {
  readonly effectLeases: EffectLeaseCoordinatorLike;

  static async acquire(options: DurableRunOwnershipOptions): Promise<DurableRunOwnership> {
    const runLease = await DurableRunLeaseHeartbeat.acquire({
      store: options.runStore,
      sessionId: options.sessionId,
      runId: options.runId,
      onOwnershipLost: (error) => options.onOwnershipLost('run', error),
    });
    const effectLeases = new DurableEffectLeaseCoordinator({
      store: options.effectStore,
      sessionId: options.sessionId,
      runId: options.runId,
      onOwnershipLost: (error) => options.onOwnershipLost('effect', error),
    });
    return new DurableRunOwnership(runLease, effectLeases);
  }

  private constructor(
    private readonly runLease: DurableRunLeaseHeartbeat,
    private readonly effectCoordinator: DurableEffectLeaseCoordinator,
  ) {
    this.effectLeases = effectCoordinator;
  }

  async release(): Promise<void> {
    let firstFailure: unknown;
    try {
      await this.effectCoordinator.releaseAll();
    } catch (error) {
      firstFailure = error;
    }
    try {
      await this.runLease.release();
    } catch (error) {
      firstFailure ??= error;
    }
    if (firstFailure) throw firstFailure;
  }
}
