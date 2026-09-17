// @littlesheep/types — observable Model, Tool, and Runtime activity contracts.
import type { StageName } from './agent.js';
import type { RuntimeCapabilityProbe, RuntimeCapabilitySnapshot, RuntimePermissionEvent } from './capability.js';
import type { TaskBook, TaskStepStatus, VerificationRecord } from './task.js';

export type StreamEvent =
  | { stream: 'lifecycle'; phase: 'start' | 'end' | 'error'; runId: string; stage?: StageName }
  | { stream: 'assistant'; runId: string; delta: string; stage?: StageName }
  | { stream: 'tool'; runId: string; event: 'start' | 'update' | 'end'; callId: string; name: string; data?: unknown };

export interface TranscriptStreamRef {
  version: 1;
  runId: string;
  requestId: string;
  transportAttempt: number;
  sequence: number;
  operation: 'append' | 'replace' | 'reset';
}

export type ObservableActivityKind =
  | 'request_dispatch'
  | 'model_request'
  | 'runtime_context'
  | 'runtime_recovery'
  | 'runtime_validation'
  | 'runtime_compaction'
  | 'runtime_persistence'
  | 'runtime_waiting_approval'

export type ObservableActivityStatus = 'running' | 'done' | 'failed' | 'aborted'

export interface ToolStreamEvent {
  type: 'reasoning' | 'model_activity' | 'runtime_activity' | 'model_reasoning' | 'model_text' | 'tool_preparing' | 'system_prompt' | 'task_book' | 'step_start' | 'step_done' | 'step_failed' | 'step_skipped' | 'tool_start' | 'tool_end' | 'verification_start' | 'verification' | 'final_delta' | 'capability_snapshot' | 'capability_probe'
  visibility?: 'silent' | 'progress'
  phaseId?: string
  /** Legacy control-state field; new observable activity must not depend on it. */
  stage?: StageName
  reasoningStatus?: 'running' | 'done' | 'failed' | 'aborted'
  activityKind?: ObservableActivityKind
  activityStatus?: ObservableActivityStatus
  requestId?: string
  streamRef?: TranscriptStreamRef
  toolCallIndex?: number
  receivedCharacters?: number
  generationStatus?: 'running' | 'done' | 'failed' | 'aborted'
  callId?: string
  name?: string
  stepId?: string
  title?: string
  description?: string
  status?: TaskStepStatus
  summary?: string
  input?: unknown
  ok?: boolean
  output?: string
  error?: string
  durationMs?: number
  taskBook?: TaskBook
  verification?: VerificationRecord
  capabilitySnapshot?: RuntimeCapabilitySnapshot
  capabilityProbe?: RuntimeCapabilityProbe
  permissionEvent?: RuntimePermissionEvent
}
