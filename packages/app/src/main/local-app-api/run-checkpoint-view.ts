// Converts internal checkpoint state into bounded user-facing diagnostics.

import type {
  RunCheckpointInspection,
  RunCheckpointStoreDiagnostics,
} from '@littlesheep/runner'
import type { PlanStep, TaskStepResult } from '@littlesheep/types'
import type {
  LocalAppRunCheckpointDetail,
  LocalAppRunCheckpointDiagnostics,
  LocalAppRunCheckpointSideEffect,
  LocalAppRunCheckpointStep,
  LocalAppRunCheckpointSummary,
} from '../../shared/run-checkpoint-contracts.js'

const MAX_TEXT = 2_048
const MAX_SHORT_TEXT = 512
const MAX_STEPS = 64
const MAX_CRITERIA = 32
const MAX_SIDE_EFFECTS = 64
const MAX_RESOURCE_KEYS = 8

/** Keep only the newest immutable snapshot for each source run. */
export function pendingCheckpointHeads(
  inspections: readonly RunCheckpointInspection[],
): RunCheckpointInspection[] {
  const seenRuns = new Set<string>()
  const result: RunCheckpointInspection[] = []
  for (const inspection of inspections) {
    const runId = String(inspection.checkpoint.runId)
    if (seenRuns.has(runId)) continue
    seenRuns.add(runId)
    const status = inspection.disposition?.status
    if (status === 'resumed' || status === 'completed' || status === 'abandoned') continue
    result.push(inspection)
  }
  return result
}

export function toCheckpointSummary(
  inspection: RunCheckpointInspection,
): LocalAppRunCheckpointSummary {
  const { checkpoint, disposition } = inspection
  const taskSteps = checkpoint.taskBook?.steps ?? []
  const executionSteps = checkpoint.taskExecution?.steps ?? []
  const completedSteps = executionSteps.filter((step) => step.status === 'done').length
  const failedSteps = executionSteps.filter((step) => step.status === 'failed').length
  const activeStepIds = (checkpoint.activeStepIds?.length
    ? checkpoint.activeStepIds
    : executionSteps.filter((step) => step.status === 'in_progress').map((step) => step.stepId))
    .slice(0, 4)
  const activeSteps = activeStepIds
    .map((stepId) => executionSteps.find((step) => step.stepId === stepId)
      ?? taskSteps.find((step) => step.id === stepId))
    .filter((step): step is PlanStep | TaskStepResult => Boolean(step))
  const currentStep = activeSteps[0]
    ?? executionSteps.find((step) => step.stepId === checkpoint.currentStepId)
    ?? taskSteps.find((step) => step.id === checkpoint.currentStepId)
  const unverified = checkpoint.sideEffects.filter((effect) => (
    effect.status === 'in_progress' || effect.status === 'unknown'
  )).length
  return {
    id: checkpoint.id,
    sourceRunId: String(checkpoint.runId),
    sessionId: String(checkpoint.sessionId),
    status: checkpoint.status,
    currentStage: checkpoint.currentStage,
    ...(checkpoint.currentStepId ? { currentStepId: checkpoint.currentStepId } : {}),
    ...(activeStepIds.length > 0 ? { activeStepIds } : {}),
    createdAt: checkpoint.createdAt,
    reason: bounded(checkpoint.reason, MAX_TEXT),
    resumable: inspection.resumable,
    blockers: inspection.reasons.slice(0, 8).map((reason) => bounded(reason, MAX_SHORT_TEXT)),
    waitingForInput: checkpoint.status === 'waiting_user',
    ...(checkpoint.resumeState?.model ? { model: checkpoint.resumeState.model } : {}),
    ...(checkpoint.resumeState?.cwd ? { workspace: bounded(checkpoint.resumeState.cwd, MAX_TEXT) } : {}),
    ...(checkpoint.resumeState?.workspaceContext?.projectId
      ? { projectId: checkpoint.resumeState.workspaceContext.projectId }
      : {}),
    ...(checkpoint.resumeState?.permissionPolicyId
      ? { permissionMode: checkpoint.resumeState.permissionPolicyId }
      : {}),
    ...(checkpoint.resumeState?.behaviorModeId ? { profile: checkpoint.resumeState.behaviorModeId } : {}),
    ...(checkpoint.resumeState?.reasoning ? { reasoning: checkpoint.resumeState.reasoning } : {}),
    ...(checkpoint.taskBook?.goal
      ? { goal: bounded(checkpoint.taskBook.goal, MAX_TEXT), complexity: checkpoint.taskBook.complexity }
      : {}),
    taskBookRevision: checkpoint.taskBookRevision,
    progress: {
      completedSteps,
      failedSteps,
      totalSteps: Math.max(taskSteps.length, executionSteps.length),
      ...(currentStep ? { currentStepTitle: stepTitle(currentStep) } : {}),
      ...(activeSteps.length > 0 ? { activeStepTitles: activeSteps.map(stepTitle) } : {}),
    },
    sideEffects: {
      total: checkpoint.sideEffects.length,
      succeeded: checkpoint.sideEffects.filter((effect) => effect.status === 'succeeded').length,
      failed: checkpoint.sideEffects.filter((effect) => effect.status === 'failed').length,
      unverified,
    },
    ...(disposition ? {
      disposition: {
        status: disposition.status,
        updatedAt: disposition.updatedAt,
        reason: bounded(disposition.reason, MAX_TEXT),
        ...(disposition.resultStatus ? { resultStatus: disposition.resultStatus } : {}),
      },
    } : {}),
  }
}

export function toCheckpointDetail(
  inspection: RunCheckpointInspection,
): LocalAppRunCheckpointDetail {
  const { checkpoint } = inspection
  const executions = new Map((checkpoint.taskExecution?.steps ?? []).map((step) => [step.stepId, step]))
  const planned = checkpoint.taskBook?.steps ?? []
  const steps = planned.length > 0
    ? planned.slice(0, MAX_STEPS).map((step, index) => toStep(step, executions.get(step.id ?? `step-${index + 1}`), index))
    : (checkpoint.taskExecution?.steps ?? []).slice(0, MAX_STEPS).map((step, index) => toStep(undefined, step, index))
  return {
    ...toCheckpointSummary(inspection),
    successCriteria: (checkpoint.taskBook?.successCriteria ?? [])
      .slice(0, MAX_CRITERIA)
      .map((criterion) => bounded(criterion, MAX_TEXT)),
    steps,
    pendingEventCount: checkpoint.pendingEventIds.length,
    contextSnapshotCount: checkpoint.contextSnapshotIds.length,
    loopBudget: {
      attemptsUsed: checkpoint.loopBudget.attemptsUsed,
      maxAttempts: checkpoint.loopBudget.maxAttempts,
      elapsedMs: checkpoint.loopBudget.elapsedMs,
      maxElapsedMs: checkpoint.loopBudget.maxElapsedMs,
      noProgressRounds: checkpoint.loopBudget.noProgressRounds,
      maxNoProgressRounds: checkpoint.loopBudget.maxNoProgressRounds,
    },
    sideEffectDetails: checkpoint.sideEffects.slice(0, MAX_SIDE_EFFECTS).map((effect): LocalAppRunCheckpointSideEffect => ({
      toolName: bounded(effect.toolName, MAX_SHORT_TEXT),
      status: effect.status,
      ...(effect.effectKind ? { effectKind: effect.effectKind } : {}),
      ...(effect.stepId ? { stepId: bounded(effect.stepId, MAX_SHORT_TEXT) } : {}),
      resourceKeys: (effect.resourceKeys ?? []).slice(0, MAX_RESOURCE_KEYS).map((key) => bounded(key, MAX_TEXT)),
      ...(effect.startedAt ? { startedAt: effect.startedAt } : {}),
      ...(effect.endedAt ? { endedAt: effect.endedAt } : {}),
      ...(effect.error ? { error: bounded(effect.error, MAX_TEXT) } : {}),
    })),
  }
}

export function toCheckpointDiagnostics(
  diagnostics: RunCheckpointStoreDiagnostics,
): LocalAppRunCheckpointDiagnostics {
  return {
    invalidFiles: diagnostics.invalidFiles,
    warningCount: diagnostics.diagnostics.length,
  }
}

function toStep(
  planned: PlanStep | undefined,
  execution: TaskStepResult | undefined,
  index: number,
): LocalAppRunCheckpointStep {
  const id = planned?.id ?? execution?.stepId ?? `step-${index + 1}`
  return {
    id: bounded(id, MAX_SHORT_TEXT),
    title: bounded(planned?.title ?? execution?.title ?? `步骤 ${index + 1}`, MAX_SHORT_TEXT),
    description: bounded(planned?.description ?? execution?.description ?? '', MAX_TEXT),
    status: execution?.status ?? planned?.status ?? 'pending',
    acceptanceCriteria: (planned?.acceptanceCriteria ?? execution?.acceptanceCriteria ?? [])
      .slice(0, MAX_CRITERIA)
      .map((criterion) => bounded(criterion, MAX_TEXT)),
    ...(planned?.expectedOutput || execution?.expectedOutput
      ? { expectedOutput: bounded(planned?.expectedOutput ?? execution?.expectedOutput ?? '', MAX_TEXT) }
      : {}),
    ...(execution?.output ? { output: bounded(execution.output, MAX_TEXT) } : {}),
    ...(execution?.error ? { error: bounded(execution.error, MAX_TEXT) } : {}),
  }
}

function stepTitle(step: PlanStep | TaskStepResult): string {
  return bounded(step.title ?? step.description, MAX_SHORT_TEXT)
}

function bounded(value: string, maximum: number): string {
  const normalized = value.trim()
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`
}
