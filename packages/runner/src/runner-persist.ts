import type { AgentResult, SessionId } from '@littlesheep/types';
import type { ExecutionLogStore } from './execution-log.js';
import { buildSessionRunSummary } from './session-run-summary.js';
import { completeRunVersionCheckpoint } from './version-checkpoint-lifecycle.js';
import type { RunGitCheckpoint } from '@littlesheep/snapshot';

export type PersistableRunnerResult = AgentResult & {
  sessionId: SessionId;
  memoryAccess?: unknown;
};

export interface PersistRunnerPhaseOptions<TResult extends PersistableRunnerResult> {
  result: TResult;
  sessionId: SessionId;
  startedAt: number;
  inputText: string;
  model: string;
  runCheckpointId?: string;
  runtimeResourceObservation: unknown;
  executionLogStore: ExecutionLogStore;
  activeCheckpoint?: RunGitCheckpoint;
  onCheckpointCompleted: (completed: boolean) => void;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

/** Persist the audit log, latest session summary, and version checkpoint. */
export async function persistRunnerPhase<TResult extends PersistableRunnerResult>(
  options: PersistRunnerPhaseOptions<TResult>,
): Promise<void> {
  const { result } = options;
  try {
    await options.executionLogStore.write({
      runId: result.runId,
      sessionId: result.sessionId,
      startedAt: new Date(options.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      status: result.status as 'ok' | 'error' | 'aborted',
      model: options.model,
      inboundText: options.inputText,
      reply: result.reply ?? '',
      replyProvenance: result.replyProvenance as never,
      error: result.error,
      trace: result.trace as never,
      taskExecution: result.taskExecution as never,
      taskBook: result.taskBook as never,
      verificationHistory: result.verificationHistory as never,
      memoryIntentDecisions: result.memoryIntentDecisions as never,
      memoryKnownState: result.memoryKnownState as never,
      memoryContinuityAssessment: result.memoryContinuityAssessment as never,
      clarificationRequest: result.clarificationRequest as never,
      clarificationResponse: result.clarificationResponse as never,
      memoryAccess: result.memoryAccess as never,
      resolvedRunConfig: result.resolvedRunConfig as never,
      modelRequests: result.modelRequests as never,
      contextSnapshots: result.contextSnapshots as never,
      runtimeControl: result.runtimeControl as never,
      runtimeEventQueue: result.runtimeEventQueue as never,
      runCheckpointId: options.runCheckpointId,
      runtimeResources: options.runtimeResourceObservation as never,
      toolInvocations: result.toolInvocations as never,
      toolInvocationsTruncated: result.toolInvocationsTruncated,
      messages: result.messages as never,
      durationMs: result.durationMs,
    });
  } catch (err) {
    options.log?.('error', `runner: failed to write execution log: ${(err as Error).message}`);
  }

  try {
    await options.executionLogStore.writeLatestForSession(options.sessionId, buildSessionRunSummary({
      runId: result.runId,
      status: result.status as 'ok' | 'error' | 'aborted',
      startedAtMs: options.startedAt,
      durationMs: result.durationMs ?? 0,
      messages: result.messages as never,
      taskExecution: result.taskExecution as never,
      taskBook: result.taskBook as never,
    }));
  } catch (err) {
    options.log?.('warn', `runner: failed to persist last-run timing summary: ${(err as Error).message}`);
  }

  if (options.activeCheckpoint) {
    const completed = await completeRunVersionCheckpoint({
      checkpoint: options.activeCheckpoint,
      result: result as never,
      sessionId: options.sessionId,
      startedAtMs: options.startedAt,
      executionLogStore: options.executionLogStore,
      log: options.log,
    });
    options.onCheckpointCompleted(completed);
  }
}
