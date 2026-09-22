// Conversation rendering and execution-progress presentation.
import type { ActivityVisibility, HistoryActivity } from '../../shared/history-activity'
import type { ObservableActivityKind, StageName, WebEvidenceProjection } from '@littlesheep/types'
import {
  type AttachmentRef
} from '../api'
import { WorkspaceArtifactRef } from '../workspace/types'
import type { RunUsage } from '@littlesheep/types'
import type { CacheCallObservation } from '../../shared/cache-call-observations'
import type { ConversationContextProjection } from './context-projections'


export interface ChatMessage {
  /** Durable history id when loaded from a session; live messages get a local id. */
  id?: string
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
  attachments?: AttachmentRef[]
  artifacts?: WorkspaceArtifactRef[]
  trace?: { name: string; ok: boolean }[]
  toolCalls?: { name: string; input: unknown; output?: unknown; error?: string; ok: boolean }[]
  durationMs?: number
  usage?: RunUsage
  /** Per-call cache evidence for this run, ordered as executed. */
  cacheCalls?: CacheCallObservation[]
  /** Run-level top prefix-invalidation reasons behind provider cache misses. */
  cacheReasons?: Array<{ reason: string; count: number }>
  cacheCallsTruncated?: boolean
  modelRef?: string
  activity?: AssistantTurnActivity
  activityCollapsed?: boolean
  webEvidence?: WebEvidenceProjection
}


export interface LiveToolEvent {
  callId: string
  name: string
  stepId?: string
  startedAt?: number
  endedAt?: number
  input?: unknown
  ok?: boolean
  output?: string
  error?: string
}


export type LiveStepStatus = HistoryActivity['steps'][number]['status']


export interface LiveStepEvent {
  stepId: string
  title: string
  description?: string
  status: LiveStepStatus
  startedAt?: number
  endedAt?: number
  output?: string
  error?: string
  toolCount: number
  activeTools: number
}


export type AssistantTurnStatus = HistoryActivity['status']


export interface LiveReasoningEvent {
  phaseId: string
  /** Legacy stage is retained only for old in-memory shapes. */
  stage?: StageName
  source?: 'model' | 'runtime'
  activityKind?: ObservableActivityKind
  summary: string
  status: 'running' | 'done' | 'failed' | 'aborted'
  startedAt: number
  endedAt?: number
  durationMs?: number
}


/** One ordered row of the model transcript (thinking / prose / tool). */
export type TranscriptEntry =
  | { kind: 'reasoning'; id: string; text: string; status: 'running' | 'done' | 'failed' | 'aborted' }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'system'; id: string; text: string }
  | { kind: 'preparing'; id: string; name?: string; receivedCharacters: number; status: 'running' | 'done' | 'failed' | 'aborted' }
  | { kind: 'tool'; id: string; callId: string }

export interface AssistantTurnActivity extends Omit<HistoryActivity, 'status' | 'steps' | 'tools'> {
  status: AssistantTurnStatus
  visibility?: ActivityVisibility
  reasoning?: LiveReasoningEvent[]
  steps: LiveStepEvent[]
  tools: LiveToolEvent[]
  /** Present for the durable transcript; render rows in this order. */
  transcript?: TranscriptEntry[]
  transcriptStreamWatermarks?: Record<string, number>
  transcriptLatestAttempts?: Record<string, number>
  transcriptIncompleteStreams?: Record<string, boolean>
  contextProjections?: ConversationContextProjection[]
}
