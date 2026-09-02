// Conversation rendering and execution-progress presentation.
import type { ActivityVisibility, HistoryActivity } from '../../shared/history-activity'
import type { StageName, WebEvidenceProjection } from '@littlesheep/types'
import {
  type AttachmentRef
} from '../api'
import { WorkspaceArtifactRef } from '../workspace/types'


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


export type LiveStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'


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


export type AssistantTurnStatus = 'running' | 'done' | 'failed' | 'aborted' | 'paused'


export interface LiveReasoningEvent {
  phaseId: string
  stage: StageName
  summary: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  durationMs?: number
}


export interface AssistantTurnActivity extends Omit<HistoryActivity, 'status' | 'steps' | 'tools'> {
  status: AssistantTurnStatus
  visibility?: ActivityVisibility
  reasoning?: LiveReasoningEvent[]
  steps: LiveStepEvent[]
  tools: LiveToolEvent[]
}
