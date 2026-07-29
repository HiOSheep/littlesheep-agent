// Per-run host interruption and timeout ownership, independent from renderer connections.

import type { RunConfigOrigin } from '@littlesheep/types';
import type { ActiveRunRegistrationOptions } from './active-run-activity.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface RunAbortControlOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  origin: RunConfigOrigin;
  startedAt: number;
}

export interface RunAbortControl {
  signal: AbortSignal;
  registration: ActiveRunRegistrationOptions;
  dispose(): void;
}

export function resolveRunTimeoutMs(explicit: number | undefined, defaultSeconds: number): number {
  const value = explicit ?? Math.round(defaultSeconds * 1_000);
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, value));
}

export function createRunAbortControl(options: RunAbortControlOptions): RunAbortControl {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = options.timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error('run timeout exceeded')), options.timeoutMs)
    : undefined;
  return {
    signal,
    registration: {
      origin: options.origin,
      startedAt: new Date(options.startedAt).toISOString(),
      interrupt: (reason?: string) => controller.abort(
        reason ? new Error(reason) : new Error('run interrupted by host control'),
      ),
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
    },
  };
}
