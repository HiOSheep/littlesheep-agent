// Bounded ownership registry for active run event queues.
// One run owns one queue; unregister/dispose releases every retained payload.

import type {
  RuntimeEventAppendInput,
  RuntimeEventIngress,
  RuntimeEventIngressOutcome,
  RuntimeEventQueueSummary,
  SessionId,
  RuntimeEventQueueSnapshot,
} from '@littlesheep/types';
import { RuntimeEventQueue, type RuntimeEventQueueOptions } from './runtime-event-queue.js';

export const DEFAULT_MAX_ACTIVE_RUNTIME_RUNS = 32 as const;
export const MAX_ACTIVE_RUNTIME_RUNS = 128 as const;

export interface ActiveRunRegistryOptions {
  maxActiveRuns?: number;
  queueOptions?: Omit<RuntimeEventQueueOptions, 'runId' | 'sessionId'>;
}

export class ActiveRunRegistry implements RuntimeEventIngress {
  private readonly maxActiveRuns: number;
  private readonly queueOptions: Omit<RuntimeEventQueueOptions, 'runId' | 'sessionId'>;
  private readonly queues = new Map<string, RuntimeEventQueue>();
  private disposed = false;

  constructor(options: ActiveRunRegistryOptions = {}) {
    this.maxActiveRuns = boundedInteger(
      options.maxActiveRuns,
      DEFAULT_MAX_ACTIVE_RUNTIME_RUNS,
      1,
      MAX_ACTIVE_RUNTIME_RUNS,
    );
    this.queueOptions = { ...(options.queueOptions ?? {}) };
  }

  register(runId: string, sessionId: SessionId): RuntimeEventQueue {
    this.ensureUsable();
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) throw new Error('active run id must be non-empty');
    if (this.queues.has(normalizedRunId)) throw new Error(`active run already registered: ${normalizedRunId}`);
    if (this.queues.size >= this.maxActiveRuns) {
      throw new Error(`active run registry reached its ${this.maxActiveRuns} run limit`);
    }
    const queue = new RuntimeEventQueue({
      ...this.queueOptions,
      runId: normalizedRunId,
      sessionId,
    });
    this.queues.set(normalizedRunId, queue);
    return queue;
  }

  registerFromSnapshot(
    runId: string,
    sessionId: SessionId,
    snapshot: RuntimeEventQueueSnapshot,
  ): RuntimeEventQueue {
    this.ensureUsable();
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) throw new Error('active run id must be non-empty');
    if (this.queues.has(normalizedRunId)) throw new Error(`active run already registered: ${normalizedRunId}`);
    if (this.queues.size >= this.maxActiveRuns) {
      throw new Error(`active run registry reached its ${this.maxActiveRuns} run limit`);
    }
    const queue = RuntimeEventQueue.fromSnapshot(snapshot, {
      ...this.queueOptions,
      runId: normalizedRunId,
      sessionId,
    });
    this.queues.set(normalizedRunId, queue);
    return queue;
  }

  append(
    runId: string,
    input: Omit<RuntimeEventAppendInput, 'runId'>,
  ): RuntimeEventIngressOutcome {
    if (this.disposed) {
      return { kind: 'rejected', reason: 'run-not-active', message: 'Runtime event ingress is disposed.' };
    }
    const queue = this.queues.get(runId);
    if (!queue) {
      return { kind: 'rejected', reason: 'run-not-active', message: `Run is not active: ${runId}` };
    }
    return queue.append({ ...input, runId });
  }

  summary(runId: string): RuntimeEventQueueSummary | null {
    if (this.disposed) return null;
    return this.queues.get(runId)?.summary() ?? null;
  }

  queue(runId: string): RuntimeEventQueue | undefined {
    if (this.disposed) return undefined;
    return this.queues.get(runId);
  }

  unregister(runId: string): boolean {
    const queue = this.queues.get(runId);
    if (!queue) return false;
    this.queues.delete(runId);
    queue.dispose();
    return true;
  }

  get size(): number {
    return this.queues.size;
  }

  has(runId: string): boolean {
    return !this.disposed && this.queues.has(runId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const queue of this.queues.values()) queue.dispose();
    this.queues.clear();
  }

  private ensureUsable(): void {
    if (this.disposed) throw new Error('active run registry has been disposed');
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value!));
}
