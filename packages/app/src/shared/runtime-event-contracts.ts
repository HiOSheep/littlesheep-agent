// Local App API contracts for bounded control events targeting an active run.

import type {
  RuntimeEventIngressOutcome,
  RuntimeEventQueueSummary,
  RuntimeEventType,
} from '@littlesheep/types'

export const LOCAL_APP_RUNTIME_CONTROL_EVENT_TYPES = [
  'pause_requested',
  'resume_requested',
  'interrupt_requested',
] as const satisfies readonly RuntimeEventType[]

export const LOCAL_APP_RUNTIME_TASK_EVENT_TYPES = [
  'user_message',
  'setting_changed',
  'workspace_file_saved',
] as const satisfies readonly RuntimeEventType[]

export type LocalAppRuntimeControlEventType = typeof LOCAL_APP_RUNTIME_CONTROL_EVENT_TYPES[number]
export type LocalAppRuntimeTaskEventType = typeof LOCAL_APP_RUNTIME_TASK_EVENT_TYPES[number]

export interface LocalAppRuntimeControlEventRequest {
  type: LocalAppRuntimeControlEventType
  reason?: string
}

export interface LocalAppRuntimeTaskEventRequest {
  type: LocalAppRuntimeTaskEventType
  /** Event-specific data. The main process applies a second validation layer. */
  payload?: Record<string, unknown>
  /** Convenience form for user_message callers. */
  text?: string
  /** Optional host-generated deduplication and expiry metadata. */
  id?: string
  dedupKey?: string
  receivedAt?: string
  expiresAt?: string
  /** Optional runtime-owned TaskBook patch carried by this event. */
  taskBookPatch?: unknown
  patch?: unknown
  reason?: string
}

export interface LocalAppRuntimeControlEventResponse {
  runId: string
  outcome: RuntimeEventIngressOutcome
  summary: RuntimeEventQueueSummary | null
}

export type LocalAppRuntimeTaskEventResponse = LocalAppRuntimeControlEventResponse

export function isLocalAppRuntimeControlEventType(value: unknown): value is LocalAppRuntimeControlEventType {
  return typeof value === 'string'
    && LOCAL_APP_RUNTIME_CONTROL_EVENT_TYPES.includes(value as LocalAppRuntimeControlEventType)
}

export function isLocalAppRuntimeTaskEventType(value: unknown): value is LocalAppRuntimeTaskEventType {
  return typeof value === 'string'
    && LOCAL_APP_RUNTIME_TASK_EVENT_TYPES.includes(value as LocalAppRuntimeTaskEventType)
}
