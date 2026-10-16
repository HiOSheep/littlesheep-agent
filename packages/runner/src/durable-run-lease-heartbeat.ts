// Process-local renewal driver for the durable cross-process run lease.
// Losing ownership aborts semantic work through a Runner-owned callback.
import {
  DurableRunLeaseStore,
  type DurableRunLease,
} from './durable-run-lease-store.js';

const MIN_RENEW_DELAY_MS = 250;

export interface DurableRunLeaseHeartbeatOptions {
  store: DurableRunLeaseStore;
  sessionId: string;
  runId: string;
  onOwnershipLost: (error: Error) => void;
}

export class DurableRunLeaseHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private lease: DurableRunLease;
  private closed = false;
  private renewal: Promise<void> | undefined;

  static async acquire(options: DurableRunLeaseHeartbeatOptions): Promise<DurableRunLeaseHeartbeat> {
    const outcome = await options.store.acquire(options.sessionId, options.runId);
    if (outcome.kind === 'conflict') {
      throw new Error(`durable run is owned by another process until ${outcome.lease.leaseUntil ?? 'unknown'}`);
    }
    const heartbeat = new DurableRunLeaseHeartbeat(options, outcome.lease);
    heartbeat.schedule();
    return heartbeat;
  }

  private constructor(
    private readonly options: DurableRunLeaseHeartbeatOptions,
    lease: DurableRunLease,
  ) {
    this.lease = lease;
  }

  get ownerToken(): string {
    return this.lease.ownerToken!;
  }

  /** Revalidates and extends the Run lease immediately before a new effect lease is acquired or confirmed. */
  async assertOwned(): Promise<void> {
    if (this.closed) throw new Error('durable run lease is no longer owned');
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.renew();
  }

  async release(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.options.store.release(
      this.options.sessionId,
      this.options.runId,
      this.ownerToken,
    );
  }

  abandon(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.closed || !this.lease.leaseUntil) return;
    const remainingMs = Date.parse(this.lease.leaseUntil) - Date.now();
    const delayMs = Math.max(MIN_RENEW_DELAY_MS, Math.floor(remainingMs / 2));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.renew().catch(() => undefined);
    }, delayMs);
    this.timer.unref?.();
  }

  private async renew(): Promise<void> {
    if (this.closed) return;
    if (this.renewal) return this.renewal;
    const operation = this.options.store.renew(
      this.options.sessionId,
      this.options.runId,
      this.ownerToken,
    ).then((lease) => {
      this.lease = lease;
      this.schedule();
    }).catch((error: unknown) => {
      this.abandon();
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.options.onOwnershipLost(normalized);
      throw normalized;
    });
    this.renewal = operation;
    try {
      await operation;
    } finally {
      if (this.renewal === operation) this.renewal = undefined;
    }
  }
}
