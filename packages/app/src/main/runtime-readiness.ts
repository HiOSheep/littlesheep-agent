// Live execution-readiness state for the desktop composition root.
//
// The Renderer mounts before the Runner exists, so it needs a fact, not a
// guess. This module owns that one fact: the current startup stage, whether
// execution is available, and if not, why. It publishes to the visible window
// through the preload channel in `../shared/runtime-readiness-contracts.ts`.
//
// Boundary: this is not a scheduler, a progress bar, or a retry framework. It
// only records what Main already knows and forwards it.

import type { BrowserWindow } from 'electron'
import {
  RUNTIME_READINESS_API_VERSION,
  type RuntimeReadiness,
  type RuntimeReadinessPhase,
} from '../shared/runtime-readiness-contracts.js'
import { RUNTIME_READINESS_CHANNEL } from '../shared/runtime-readiness-ipc.js'

export interface RuntimeReadinessController {
  current(): RuntimeReadiness
  /** Record the stage being worked on while execution stays unavailable. */
  begin(phase: RuntimeReadinessPhase, reason: string, options?: { port?: number }): RuntimeReadiness
  /** Execution is possible now. */
  ready(phase?: RuntimeReadinessPhase): RuntimeReadiness
  /** Execution will not become available without a user decision. */
  fail(reason: string, options?: { retryable?: boolean }): RuntimeReadiness
  subscribe(listener: (state: RuntimeReadiness) => void): () => void
}

export function createRuntimeReadinessController(options: {
  /** Resolved on every publish: the shell may replace its window at any time. */
  getWindow?: () => BrowserWindow | undefined
  onWarning?: (message: string) => void
} = {}): RuntimeReadinessController {
  let state: RuntimeReadiness = {
    state: 'starting',
    phase: 'data-root',
    reason: '正在准备本机数据目录',
    apiVersion: RUNTIME_READINESS_API_VERSION,
    retryable: false,
  }
  let window: BrowserWindow | undefined
  const listeners = new Set<(state: RuntimeReadiness) => void>()

  function publish(next: RuntimeReadiness): RuntimeReadiness {
    state = next
    for (const listener of [...listeners]) {
      try {
        listener(state)
      } catch (error) {
        options.onWarning?.(`readiness listener failed: ${(error as Error).message}`)
      }
    }
    const target = options.getWindow?.() ?? window
    if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) {
      window = target
      try {
        target.webContents.send(RUNTIME_READINESS_CHANNEL, state)
      } catch (error) {
        options.onWarning?.(`readiness publish failed: ${(error as Error).message}`)
      }
    }
    return state
  }

  return {
    current: () => state,
    begin: (phase, reason, beginOptions = {}) => publish({
      ...state,
      state: 'starting',
      phase,
      reason,
      ...(beginOptions.port === undefined ? {} : { port: beginOptions.port }),
      retryable: false,
    }),
    ready: (phase = 'execution') => publish({
      state: 'ready',
      phase,
      apiVersion: RUNTIME_READINESS_API_VERSION,
      ...(state.port === undefined ? {} : { port: state.port }),
      retryable: false,
    }),
    fail: (reason, failOptions = {}) => publish({
      ...state,
      state: 'failed',
      reason,
      retryable: failOptions.retryable ?? false,
    }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
