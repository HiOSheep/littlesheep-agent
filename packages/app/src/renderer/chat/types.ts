// Conversation rendering and execution-progress presentation.
import type { HistoryActivity } from '../../shared/history-activity'
import {
type AttachmentRef
} from '../api'
import { WorkspaceArtifactRef } from '../workspace/types'


export interface ChatMessage {
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


export type AssistantTurnStatus = 'running' | 'done' | 'failed' | 'aborted'


export interface AssistantTurnActivity extends Omit<HistoryActivity, 'status' | 'steps' | 'tools'> {
  status: AssistantTurnStatus
  steps: LiveStepEvent[]
  tools: LiveToolEvent[]
}
