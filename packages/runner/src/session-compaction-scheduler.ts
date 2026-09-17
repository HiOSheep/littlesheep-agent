// Owns automatic session-compaction operations: single flight per session,
// a global soft-concurrency cap, coalescing, cancellation and bounded history.

import { randomUUID } from 'node:crypto';
import type { SessionId } from '@littlesheep/types';

export type SessionCompactionOperationStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'deferred';

export interface SessionCompactionOperationRecord {
  id: string;
  sessionId: string;
  force: boolean;
  createdAt: string;
  startedAt?: string;
  settledAt?: string;
  status: SessionCompactionOperationStatus;
  /** `compacted` only when a summary was actually written; `no-new-range` otherwise. */
  result?: 'compacted' | 'no-new-range';
  error?: string;
  /** Extra pressure notifications merged into this operation instead of starting a new one. */
  coalescedRequests: number;
  /** Provider cost attributed to this operation; unknown tokens stay absent, not zero. */
  usage?: SessionCompactionUsage;
}

export interface SessionCompactionUsage {
  readonly requestCount: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly usageStatus: 'reported' | 'partial' | 'unavailable';
}

export interface SessionCompactionRunContext {
  operationId: string;
  sessionId: SessionId;
  force: boolean;
  signal: AbortSignal;
}

/** Terminal result of one compaction attempt; `failed` is an operation outcome, not a run failure. */
export type SessionCompactionRunResult =
  | { status: 'compacted'; usage?: SessionCompactionUsage }
  | { status: 'no-new-range'; usage?: SessionCompactionUsage }
  | { status: 'failed'; error: string; usage?: SessionCompactionUsage };

export type SessionCompactionRunOutcome = SessionCompactionRunResult | boolean;

export interface SessionCompactionRequest {
  sessionId: SessionId;
  /** Hard/explicit pressure must run; soft automatic pressure may defer without resources. */
  force: boolean;
  /** Run-level signal. Aborting it aborts only the operation this request started or joined. */
  signal?: AbortSignal;
  run(context: SessionCompactionRunContext): Promise<SessionCompactionRunOutcome>;
}

export type SessionCompactionOutcome =
  | { status: 'completed'; operationId: string; compacted: boolean; coalesced: boolean }
  | { status: 'failed'; operationId: string; error: string }
  | { status: 'cancelled'; operationId: string; reason: string }
  | { status: 'deferred'; operationId: string; reason: 'soft-concurrency-limit' | 'scheduler-disposed' };

export interface SessionCompactionSchedulerOptions {
  maxSoftConcurrency?: number;
  now?: () => Date;
  createId?: () => string;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Persist a settled operation record for durable history; failures stay non-fatal. */
  onSettled?: (record: SessionCompactionOperationRecord) => Promise<void> | void;
}

interface SessionFlight {
  operationId: string;
  force: boolean;
  promise: Promise<SessionCompactionOutcome>;
}

const MAX_OPERATION_HISTORY = 200;

export class SessionCompactionScheduler {
  private readonly maxSoftConcurrency: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly log?: SessionCompactionSchedulerOptions['log'];
  private readonly onSettled?: SessionCompactionSchedulerOptions['onSettled'];
  private readonly sessionFlights = new Map<string, SessionFlight>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly records: SessionCompactionOperationRecord[] = [];
  private softRunning = 0;
  private disposed = false;

  constructor(options: SessionCompactionSchedulerOptions = {}) {
    this.maxSoftConcurrency = options.maxSoftConcurrency ?? 1;
    if (!Number.isInteger(this.maxSoftConcurrency) || this.maxSoftConcurrency < 0) {
      throw new Error(`Invalid soft compaction concurrency limit: ${this.maxSoftConcurrency}`);
    }
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomUUID());
    this.log = options.log;
    this.onSettled = options.onSettled;
  }

  /**
   * One session has at most one compaction flight. Extra notifications for the
   * same session coalesce into it; a hard request arriving behind a soft flight
   * waits for it and then runs its own operation.
   */
  async request(request: SessionCompactionRequest): Promise<SessionCompactionOutcome> {
    const key = String(request.sessionId);
    if (this.disposed) {
      return { status: 'deferred', operationId: this.defer('scheduler-disposed', request.sessionId), reason: 'scheduler-disposed' };
    }
    const existing = this.sessionFlights.get(key);
    if (existing) {
      if (existing.force || !request.force) {
        const record = this.records.find((entry) => entry.id === existing.operationId);
        if (record) record.coalescedRequests += 1;
        const outcome = await existing.promise;
        return outcome.status === 'completed' ? { ...outcome, coalesced: true } : outcome;
      }
      await existing.promise;
      return this.request(request);
    }
    if (!request.force && this.softRunning >= this.maxSoftConcurrency) {
      return { status: 'deferred', operationId: this.defer('soft-concurrency-limit', request.sessionId), reason: 'soft-concurrency-limit' };
    }

    const operationId = this.createId();
    const controller = new AbortController();
    if (request.signal?.aborted) controller.abort('request-signal-aborted');
    else request.signal?.addEventListener('abort', () => controller.abort('run-aborted'), { once: true });
    this.controllers.set(operationId, controller);

    const record: SessionCompactionOperationRecord = {
      id: operationId,
      sessionId: key,
      force: request.force,
      createdAt: this.now().toISOString(),
      status: 'running',
      startedAt: this.now().toISOString(),
      coalescedRequests: 0,
    };
    this.records.push(record);
    if (this.records.length > MAX_OPERATION_HISTORY) this.records.splice(0, this.records.length - MAX_OPERATION_HISTORY);
    if (!request.force) this.softRunning += 1;

    const flight: SessionFlight = {
      operationId,
      force: request.force,
      promise: Promise.resolve({ status: 'failed', operationId, error: 'not-started' } as SessionCompactionOutcome),
    };
    // Register before starting so a synchronously-settling run cannot clear a later flight.
    this.sessionFlights.set(key, flight);
    flight.promise = this.runOperation(flight, record, controller, request);
    return flight.promise;
  }

  /** Abort every owned operation. Durable proposals stay pending for recovery. */
  dispose(reason = 'scheduler-disposed'): void {
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort(reason);
  }

  /** Wait for owned operations to settle; used before the runner releases resources. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.sessionFlights.values()].map((flight) => flight.promise));
  }

  /** Bounded, ordered operation history for activity projection and accounting. */
  operations(): SessionCompactionOperationRecord[] {
    return structuredClone(this.records);
  }

  private async runOperation(
    flight: SessionFlight,
    record: SessionCompactionOperationRecord,
    controller: AbortController,
    request: SessionCompactionRequest,
  ): Promise<SessionCompactionOutcome> {
    try {
      const raw = await request.run({
        operationId: flight.operationId,
        sessionId: request.sessionId,
        force: flight.force,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        // A callback may contain its own abort error; the operation still owns the cancellation.
        const reason = String(controller.signal.reason ?? 'aborted');
        record.status = 'cancelled';
        record.error = reason;
        return { status: 'cancelled', operationId: flight.operationId, reason };
      }
      const outcome: SessionCompactionRunResult = typeof raw === 'boolean'
        ? (raw ? { status: 'compacted' } : { status: 'no-new-range' })
        : raw;
      if (outcome.status === 'failed') {
        record.status = 'failed';
        record.error = outcome.error;
        if (outcome.usage) record.usage = outcome.usage;
        this.log?.('warn', `runner: session compaction operation failed: ${outcome.error}`, { operationId: flight.operationId });
        return { status: 'failed', operationId: flight.operationId, error: outcome.error };
      }
      record.status = 'completed';
      record.result = outcome.status;
      if (outcome.usage) record.usage = outcome.usage;
      return { status: 'completed', operationId: flight.operationId, compacted: outcome.status === 'compacted', coalesced: false };
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = String(controller.signal.reason ?? 'aborted');
        record.status = 'cancelled';
        record.error = reason;
        return { status: 'cancelled', operationId: flight.operationId, reason };
      }
      const message = error instanceof Error ? error.message : String(error);
      record.status = 'failed';
      record.error = message;
      this.log?.('warn', `runner: session compaction operation failed: ${message}`, { operationId: flight.operationId });
      return { status: 'failed', operationId: flight.operationId, error: message };
    } finally {
      record.settledAt = this.now().toISOString();
      this.controllers.delete(flight.operationId);
      if (!flight.force) this.softRunning -= 1;
      if (this.sessionFlights.get(record.sessionId) === flight) this.sessionFlights.delete(record.sessionId);
      try {
        await this.onSettled?.(structuredClone(record));
      } catch (error) {
        this.log?.('warn', `runner: compaction operation history unavailable: ${(error as Error).message}`);
      }
    }
  }

  private defer(reason: 'soft-concurrency-limit' | 'scheduler-disposed', sessionId: SessionId): string {
    const operationId = this.createId();
    this.records.push({
      id: operationId,
      sessionId: String(sessionId),
      force: false,
      createdAt: this.now().toISOString(),
      settledAt: this.now().toISOString(),
      status: 'deferred',
      error: reason,
      coalescedRequests: 0,
    });
    if (this.records.length > MAX_OPERATION_HISTORY) this.records.splice(0, this.records.length - MAX_OPERATION_HISTORY);
    return operationId;
  }
}
