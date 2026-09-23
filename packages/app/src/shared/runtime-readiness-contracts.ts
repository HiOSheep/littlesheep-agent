// Execution-readiness contract shared by Main, preload and the Renderer.
//
// The desktop window becomes visible before the Runner finishes starting, so the
// Renderer must be able to answer two questions without guessing:
//   1. can this window already read local metadata (sessions, projects, config);
//   2. is execution (sending a task) possible yet, and if not, why not.
//
// This is deliberately the *only* readiness surface. It reports facts the Main
// process already owns; it is not a scheduler and carries no progress estimate.

/** Coarse startup stage the Main process is currently working through. */
export type RuntimeReadinessPhase =
  | 'data-root'
  | 'config'
  | 'ui-indexes'
  | 'api'
  | 'execution'

/** Execution availability. Only 'ready' permits sending a task. */
export type RuntimeReadinessState = 'starting' | 'ready' | 'failed'

export interface RuntimeReadiness {
  state: RuntimeReadinessState
  /** Last completed-or-in-progress startup stage. */
  phase: RuntimeReadinessPhase
  /** Why execution is unavailable; shown verbatim, never a templated promise. */
  reason?: string
  /** Bumped only when this payload's shape changes. */
  apiVersion: 1
  /** Local App API loopback port once it is listening. */
  port?: number
  /** Whether an explicit user retry can plausibly succeed. */
  retryable: boolean
}

export const RUNTIME_READINESS_API_VERSION = 1

const READINESS_PHASES: readonly RuntimeReadinessPhase[] = ['data-root', 'config', 'ui-indexes', 'api', 'execution']

const READINESS_STATES: readonly RuntimeReadinessState[] = ['starting', 'ready', 'failed']

/** Structural guard used by preload before forwarding a state across the bridge. */
export function isRuntimeReadiness(value: unknown): value is RuntimeReadiness {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RuntimeReadiness>
  if (candidate.apiVersion !== RUNTIME_READINESS_API_VERSION) return false
  if (!READINESS_STATES.includes(candidate.state as RuntimeReadinessState)) return false
  if (!READINESS_PHASES.includes(candidate.phase as RuntimeReadinessPhase)) return false
  if (typeof candidate.retryable !== 'boolean') return false
  if (candidate.reason !== undefined && typeof candidate.reason !== 'string') return false
  if (candidate.port !== undefined && (typeof candidate.port !== 'number' || !Number.isInteger(candidate.port) || candidate.port <= 0)) {
    return false
  }
  return true
}
