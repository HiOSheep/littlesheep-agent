// Bounded presentation and control state for active runs; event queues stay in ActiveRunRegistry.

import type {
  RunConfigOrigin,
  RuntimeActiveRunControlStatus,
  RuntimeActiveRunPhase,
  RuntimeActiveRunSnapshot,
  SessionId,
  ToolStreamEvent,
} from '@littlesheep/types';

export const MAX_ACTIVE_RUN_LISTENERS = 16 as const;
export const MAX_ACTIVE_RUN_STEPS = 128 as const;
export const MAX_ACTIVE_RUN_VISIBLE_STEPS = 4 as const;
export const MAX_ACTIVE_RUN_TOOLS = 128 as const;

export interface ActiveRunRegistrationOptions {
  origin?: RunConfigOrigin;
  startedAt?: string;
  interrupt?: (reason?: string) => void;
}

export interface ActiveRunActivityStoreOptions {
  now?: () => Date;
}

interface ActiveRunActivity {
  runId: string;
  sessionId: SessionId;
  origin: RunConfigOrigin;
  startedAt: string;
  updatedAt: string;
  phase: RuntimeActiveRunPhase;
  controlStatus: RuntimeActiveRunControlStatus;
  totalSteps: number;
  completedStepIds: Set<string>;
  activeSteps: Map<string, string | undefined>;
  activeTools: Set<string>;
  interrupt?: (reason?: string) => void;
}

export class ActiveRunActivityStore {
  private readonly now: () => Date;
  private readonly activities = new Map<string, ActiveRunActivity>();
  private readonly listeners = new Set<(runs: RuntimeActiveRunSnapshot[]) => void>();
  private disposed = false;

  constructor(options: ActiveRunActivityStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  register(runId: string, sessionId: SessionId, options: ActiveRunRegistrationOptions): void {
    const now = this.now().toISOString();
    this.activities.set(runId, {
      runId,
      sessionId,
      origin: options.origin ?? 'cli',
      startedAt: validTimestamp(options.startedAt) ?? now,
      updatedAt: now,
      phase: 'starting',
      controlStatus: 'running',
      totalSteps: 0,
      completedStepIds: new Set(),
      activeSteps: new Map(),
      activeTools: new Set(),
      interrupt: options.interrupt,
    });
    this.notify();
  }

  unregister(runId: string): void {
    if (this.activities.delete(runId)) this.notify();
  }

  list(): RuntimeActiveRunSnapshot[] {
    if (this.disposed) return [];
    return [...this.activities.values()]
      .map(activitySnapshot)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.runId.localeCompare(right.runId));
  }

  snapshot(runId: string): RuntimeActiveRunSnapshot | null {
    if (this.disposed) return null;
    const activity = this.activities.get(runId);
    return activity ? activitySnapshot(activity) : null;
  }

  observe(runId: string, event: ToolStreamEvent): boolean {
    if (this.disposed) return false;
    const activity = this.activities.get(runId);
    if (!activity) return false;

    if (event.type === 'task_book' && event.taskBook) {
      activity.totalSteps = Math.min(MAX_ACTIVE_RUN_STEPS, event.taskBook.steps.length);
      activity.completedStepIds.clear();
      activity.activeSteps.clear();
      for (const step of event.taskBook.steps.slice(0, MAX_ACTIVE_RUN_STEPS)) {
        if (!step.id) continue;
        if (step.status === 'done' || step.status === 'skipped') activity.completedStepIds.add(step.id);
        if (step.status === 'in_progress' && activity.activeSteps.size < MAX_ACTIVE_RUN_VISIBLE_STEPS) {
          activity.activeSteps.set(step.id, step.title);
        }
      }
    } else if (event.type === 'step_start' && event.stepId) {
      activity.phase = 'executing';
      if (activity.activeSteps.has(event.stepId) || activity.activeSteps.size < MAX_ACTIVE_RUN_VISIBLE_STEPS) {
        activity.activeSteps.set(event.stepId, boundedLabel(event.title ?? event.description));
      }
    } else if (isStepEnd(event) && event.stepId) {
      activity.phase = 'executing';
      activity.activeSteps.delete(event.stepId);
      if (event.type !== 'step_failed' && activity.completedStepIds.size < MAX_ACTIVE_RUN_STEPS) {
        activity.completedStepIds.add(event.stepId);
      }
    } else if (event.type === 'tool_start' && event.callId) {
      activity.phase = 'executing';
      if (activity.activeTools.size < MAX_ACTIVE_RUN_TOOLS) activity.activeTools.add(event.callId);
    } else if (event.type === 'tool_end' && event.callId) {
      activity.phase = 'executing';
      activity.activeTools.delete(event.callId);
    } else if (event.type === 'verification_start') {
      activity.phase = 'verifying';
    } else if (event.type === 'verification' || event.type === 'final_delta') {
      activity.phase = 'finalizing';
    }

    activity.updatedAt = this.now().toISOString();
    this.notify();
    return true;
  }

  setControlStatus(runId: string, status: RuntimeActiveRunControlStatus): RuntimeActiveRunSnapshot | null {
    if (this.disposed) return null;
    const activity = this.activities.get(runId);
    if (!activity) return null;
    activity.controlStatus = status;
    activity.updatedAt = this.now().toISOString();
    this.notify();
    return activitySnapshot(activity);
  }

  interrupt(runId: string, reason?: string): RuntimeActiveRunSnapshot | null {
    if (this.disposed) return null;
    const activity = this.activities.get(runId);
    if (!activity) return null;
    if (activity.controlStatus !== 'interrupt_requested') {
      activity.controlStatus = 'interrupt_requested';
      activity.updatedAt = this.now().toISOString();
      this.notify();
      try {
        activity.interrupt?.(boundedReason(reason));
      } catch {
        // Host interruption is synchronous and idempotent; run finalization remains authoritative.
      }
    }
    return activitySnapshot(activity);
  }

  subscribe(listener: (runs: RuntimeActiveRunSnapshot[]) => void): () => void {
    if (this.disposed) {
      listener([]);
      return () => undefined;
    }
    if (this.listeners.size >= MAX_ACTIVE_RUN_LISTENERS) {
      throw new Error(`active run registry reached its ${MAX_ACTIVE_RUN_LISTENERS} listener limit`);
    }
    this.listeners.add(listener);
    listener(this.list());
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activities.clear();
    this.notify();
    this.listeners.clear();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.list();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot.map(cloneActivitySnapshot));
      } catch {
        // Observers cannot interfere with run ownership or cleanup.
      }
    }
  }
}

function isStepEnd(event: ToolStreamEvent): boolean {
  return event.type === 'step_done' || event.type === 'step_failed' || event.type === 'step_skipped';
}

function activitySnapshot(activity: ActiveRunActivity): RuntimeActiveRunSnapshot {
  return {
    runId: activity.runId,
    sessionId: activity.sessionId,
    origin: activity.origin,
    startedAt: activity.startedAt,
    updatedAt: activity.updatedAt,
    phase: activity.phase,
    controlStatus: activity.controlStatus,
    totalSteps: activity.totalSteps,
    completedSteps: Math.min(activity.totalSteps || MAX_ACTIVE_RUN_STEPS, activity.completedStepIds.size),
    activeSteps: [...activity.activeSteps.entries()].slice(0, MAX_ACTIVE_RUN_VISIBLE_STEPS).map(([stepId, title]) => ({
      stepId,
      ...(title ? { title } : {}),
    })),
    activeToolCount: activity.activeTools.size,
  };
}

function cloneActivitySnapshot(snapshot: RuntimeActiveRunSnapshot): RuntimeActiveRunSnapshot {
  return { ...snapshot, activeSteps: snapshot.activeSteps.map((step) => ({ ...step })) };
}

function boundedLabel(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

function boundedReason(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 1_024) : undefined;
}

function validTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}
