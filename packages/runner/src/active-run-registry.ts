// Bounded ownership registry for active run event queues.
// One run owns one queue; unregister/dispose releases every retained payload.

import type {
  RuntimeActiveRunAction,
  RuntimeActiveRunActionOutcome,
  RuntimeActiveRunControl,
  RuntimeActiveRunSnapshot,
  RuntimeEventAppendInput,
  RuntimeEventIngress,
  RuntimeEventIngressOutcome,
  RuntimeEventQueueSummary,
  SessionId,
  RuntimeEventQueueSnapshot,
  ToolStreamEvent,
} from '@littlesheep/types';
import { RuntimeEventQueue, type RuntimeEventQueueOptions } from './runtime-event-queue.js';
import {
  ActiveRunActivityStore,
  type ActiveRunRegistrationOptions,
} from './active-run-activity.js';

export type { ActiveRunRegistrationOptions } from './active-run-activity.js';

export const DEFAULT_MAX_ACTIVE_RUNTIME_RUNS = 32 as const;
export const MAX_ACTIVE_RUNTIME_RUNS = 128 as const;
export interface ActiveRunRegistryOptions {
  maxActiveRuns?: number;
  queueOptions?: Omit<RuntimeEventQueueOptions, 'runId' | 'sessionId'>;
  now?: () => Date;
}

export class ActiveRunRegistry implements RuntimeEventIngress, RuntimeActiveRunControl {
  private readonly maxActiveRuns: number;
  private readonly queueOptions: Omit<RuntimeEventQueueOptions, 'runId' | 'sessionId'>;
  private readonly queues = new Map<string, RuntimeEventQueue>();
  private readonly activities: ActiveRunActivityStore;
  private disposed = false;

  constructor(options: ActiveRunRegistryOptions = {}) {
    this.maxActiveRuns = boundedInteger(
      options.maxActiveRuns,
      DEFAULT_MAX_ACTIVE_RUNTIME_RUNS,
      1,
      MAX_ACTIVE_RUNTIME_RUNS,
    );
    this.queueOptions = { ...(options.queueOptions ?? {}) };
    this.activities = new ActiveRunActivityStore({ now: options.now });
  }

  register(
    runId: string,
    sessionId: SessionId,
    options: ActiveRunRegistrationOptions = {},
  ): RuntimeEventQueue {
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
    this.activities.register(normalizedRunId, sessionId, options);
    return queue;
  }

  registerFromSnapshot(
    runId: string,
    sessionId: SessionId,
    snapshot: RuntimeEventQueueSnapshot,
    options: ActiveRunRegistrationOptions = {},
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
    this.activities.register(normalizedRunId, sessionId, options);
    return queue;
  }

  registerRun(
    runId: string,
    sessionId: SessionId,
    snapshot: RuntimeEventQueueSnapshot | undefined,
    options: ActiveRunRegistrationOptions = {},
  ): RuntimeEventQueue {
    return snapshot
      ? this.registerFromSnapshot(runId, sessionId, snapshot, options)
      : this.register(runId, sessionId, options);
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
    const outcome = queue.append({ ...input, runId });
    if (outcome.kind === 'accepted' || outcome.kind === 'duplicate') {
      const status = controlStatusForEvent(outcome.event.type);
      if (status) this.activities.setControlStatus(runId, status);
    }
    return outcome;
  }

  summary(runId: string): RuntimeEventQueueSummary | null {
    if (this.disposed) return null;
    return this.queues.get(runId)?.summary() ?? null;
  }

  queue(runId: string): RuntimeEventQueue | undefined {
    if (this.disposed) return undefined;
    return this.queues.get(runId);
  }

  list(): RuntimeActiveRunSnapshot[] {
    return this.disposed ? [] : this.activities.list();
  }

  observe(runId: string, event: ToolStreamEvent): boolean {
    return !this.disposed && this.activities.observe(runId, event);
  }

  request(
    runId: string,
    action: RuntimeActiveRunAction,
    reason?: string,
  ): RuntimeActiveRunActionOutcome {
    if (this.disposed) return inactiveOutcome(runId, action);
    const activity = this.activities.snapshot(runId);
    const queue = this.queues.get(runId);
    if (!activity || !queue) return inactiveOutcome(runId, action);
    if (activity.controlStatus === 'interrupt_requested' && action !== 'interrupt') {
      return {
        kind: 'rejected',
        action,
        reason: 'action-conflict',
        message: `Run is already stopping: ${runId}`,
      };
    }

    if (action === 'interrupt') {
      return { kind: 'accepted', action, run: this.activities.interrupt(runId, reason)! };
    }

    if (action === 'resume' && activity.controlStatus === 'running') {
      return { kind: 'accepted', action, run: activity };
    }
    if (action === 'pause' && activity.controlStatus === 'pause_requested') {
      return { kind: 'accepted', action, run: activity };
    }

    const eventType = action === 'pause' ? 'pause_requested' : 'resume_requested';
    const outcome = queue.append({
      runId,
      sessionId: activity.sessionId,
      type: eventType,
      source: 'system',
      payload: reason?.trim() ? { reason: boundedReason(reason) } : {},
    });
    if (outcome.kind === 'rejected') {
      return {
        kind: 'rejected',
        action,
        reason: 'queue-rejected',
        message: outcome.message,
      };
    }

    const run = this.activities.setControlStatus(
      runId,
      action === 'pause' ? 'pause_requested' : 'running',
    )!;
    return { kind: 'accepted', action, run };
  }

  subscribe(listener: (runs: RuntimeActiveRunSnapshot[]) => void): () => void {
    return this.activities.subscribe(listener);
  }

  unregister(runId: string): boolean {
    const queue = this.queues.get(runId);
    if (!queue) return false;
    this.queues.delete(runId);
    this.activities.unregister(runId);
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
    this.activities.dispose();
  }

  private ensureUsable(): void {
    if (this.disposed) throw new Error('active run registry has been disposed');
  }
}

function inactiveOutcome(runId: string, action: RuntimeActiveRunAction): RuntimeActiveRunActionOutcome {
  return {
    kind: 'rejected',
    action,
    reason: 'run-not-active',
    message: `Run is not active: ${runId}`,
  };
}

function boundedReason(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 1_024);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value!));
}

function controlStatusForEvent(
  type: RuntimeEventAppendInput['type'],
): RuntimeActiveRunSnapshot['controlStatus'] | undefined {
  if (type === 'pause_requested') return 'pause_requested';
  if (type === 'resume_requested') return 'running';
  if (type === 'interrupt_requested') return 'interrupt_requested';
  return undefined;
}
