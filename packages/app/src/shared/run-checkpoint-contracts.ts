// Bounded startup-recovery payloads shared by Main and Renderer.

export type LocalAppRunCheckpointStatus = 'paused' | 'waiting_user' | 'recoverable'
export type LocalAppRunCheckpointDispositionStatus = 'resuming' | 'interrupted' | 'resumed' | 'abandoned'

export interface LocalAppRunCheckpointDisposition {
  status: LocalAppRunCheckpointDispositionStatus
  updatedAt: string
  reason: string
  resultStatus?: 'ok' | 'error' | 'aborted'
}

export interface LocalAppRunCheckpointProgress {
  completedSteps: number
  failedSteps: number
  totalSteps: number
  currentStepTitle?: string
  activeStepTitles?: string[]
}

export interface LocalAppRunCheckpointSideEffectSummary {
  total: number
  succeeded: number
  failed: number
  unverified: number
}

export interface LocalAppRunCheckpointSummary {
  id: string
  sourceRunId: string
  sessionId: string
  status: LocalAppRunCheckpointStatus
  currentStage: string
  currentStepId?: string
  activeStepIds?: string[]
  createdAt: string
  reason: string
  resumable: boolean
  blockers: string[]
  waitingForInput: boolean
  model?: string
  workspace?: string
  projectId?: string
  permissionMode?: string
  profile?: string
  reasoning?: string
  goal?: string
  complexity?: string
  taskBookRevision: number
  progress: LocalAppRunCheckpointProgress
  sideEffects: LocalAppRunCheckpointSideEffectSummary
  disposition?: LocalAppRunCheckpointDisposition
}

export interface LocalAppRunCheckpointStep {
  id: string
  title: string
  description: string
  status: string
  acceptanceCriteria: string[]
  expectedOutput?: string
  output?: string
  error?: string
}

export interface LocalAppRunCheckpointSideEffect {
  toolName: string
  status: string
  effectKind?: string
  stepId?: string
  resourceKeys: string[]
  startedAt?: string
  endedAt?: string
  error?: string
}

export interface LocalAppRunCheckpointDetail extends LocalAppRunCheckpointSummary {
  successCriteria: string[]
  steps: LocalAppRunCheckpointStep[]
  pendingEventCount: number
  contextSnapshotCount: number
  loopBudget: {
    attemptsUsed: number
    maxAttempts: number
    elapsedMs: number
    maxElapsedMs: number
    noProgressRounds: number
    maxNoProgressRounds: number
  }
  sideEffectDetails: LocalAppRunCheckpointSideEffect[]
}

export interface LocalAppRunCheckpointDiagnostics {
  invalidFiles: number
  warningCount: number
}

export interface LocalAppRunCheckpointListResponse {
  checkpoints: LocalAppRunCheckpointSummary[]
  diagnostics: LocalAppRunCheckpointDiagnostics
}

export interface LocalAppRunCheckpointInspectResponse {
  checkpoint: LocalAppRunCheckpointDetail
}

export interface LocalAppRunCheckpointAbandonResponse {
  checkpointId: string
  outcome: 'abandoned' | 'duplicate'
}

export interface LocalAppRunCheckpointResumeRequest {
  text?: string
  reason?: string
}
