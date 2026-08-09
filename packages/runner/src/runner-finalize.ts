import type { RunContext, SessionId, StageResult } from '@littlesheep/types';
import type { MemoryAccessLedger } from '@littlesheep/memory-tree';
import type { MemoryService } from '@littlesheep/memory-tree';
import { collectConversationSourceRecords } from '@littlesheep/harness';
import { buildMemoryRunFeedbackInput, independentSuccessfulToolCallIds } from './memory-feedback-evidence.js';
import { recordSessionSummaryActivation } from './session-summary-activation.js';
import { compactSessionAfterRun } from './session-continuity.js';

export interface FinalizeRunnerPhaseOptions<TResult> {
  ctx: RunContext;
  stageResult: StageResult;
  runStopped: boolean;
  sessionId: SessionId;
  runId: string;
  cwd: string;
  usedContinuitySummaryId?: string;
  signal?: AbortSignal;
  runCheckpointId?: string;
  startedAt: number;
  model: string;
  compact: { threshold: number; keepRecent: number };
  infra: {
    memoryService: MemoryService;
    sessionManager: Parameters<typeof compactSessionAfterRun>[0]['sessionManager'];
    llm: Parameters<typeof compactSessionAfterRun>[0]['llm'];
  };
  assembleResult: (
    stageResult: StageResult,
    ctx: RunContext,
    sessionId: SessionId,
    startedAtMs: number,
    aborted: boolean,
    memoryAccess?: MemoryAccessLedger,
  ) => TResult;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

export interface FinalizeRunnerPhaseResult<TResult> {
  result: TResult;
  memoryAccess?: MemoryAccessLedger;
}

/** Capture memory evidence, finish the memory run, compact, and assemble the result. */
export async function finalizeRunnerPhase<TResult>(
  options: FinalizeRunnerPhaseOptions<TResult>,
): Promise<FinalizeRunnerPhaseResult<TResult>> {
  const { ctx, stageResult, runStopped } = options;
  try {
    await options.infra.memoryService.captureConversationSources(collectConversationSourceRecords(ctx));
  } catch (err) {
    options.log?.('warn', `runner: conversation source capture degraded: ${(err as Error).message}`);
  }

  const latestVerification = ctx.verificationHistory?.at(-1);
  const successfulToolCallIds = independentSuccessfulToolCallIds(ctx);
  const recordedAt = new Date().toISOString();
  const status = runStopped ? 'aborted' : stageResult.ok ? 'ok' : 'error';
  try {
    await options.infra.memoryService.recordRunFeedback(buildMemoryRunFeedbackInput({
      ctx, status, verification: latestVerification, successfulToolCallIds, recordedAt,
    }));
  } catch (err) {
    options.log?.('warn', `runner: memory usefulness feedback degraded: ${(err as Error).message}`);
  }
  try {
    await recordSessionSummaryActivation({
      sessionManager: options.infra.sessionManager,
      sessionId: options.sessionId,
      summary: ctx.sessionSummary,
      usedSummaryId: options.usedContinuitySummaryId,
      answerUsedSummaryId: ctx.memoryContinuityAssessment?.status === 'supported'
        && ctx.memoryContinuityAssessment.matchedSources.includes('session_summary')
        ? ctx.sessionSummary?.id : undefined,
      runId: ctx.runId,
      status,
      verification: latestVerification,
      successfulToolCallIds,
      recordedAt,
    });
  } catch (err) {
    options.log?.('warn', `runner: session summary activation degraded: ${(err as Error).message}`);
  }

  let memoryAccess: MemoryAccessLedger | undefined;
  try {
    memoryAccess = await options.infra.memoryService.finishRun(ctx.runId);
  } catch (err) {
    options.log?.('warn', `runner: run resource cleanup degraded: ${(err as Error).message}`);
  }

  if (!runStopped) {
    await compactSessionAfterRun({
      sessionManager: options.infra.sessionManager,
      memoryService: options.infra.memoryService,
      llm: options.infra.llm,
      ctx,
      sessionId: options.sessionId,
      runId: options.runId,
      workspace: options.cwd,
      model: ctx.resolvedRunConfig?.model ?? options.model,
      threshold: options.compact.threshold,
      keepRecent: options.compact.keepRecent,
      force: ctx.contextSnapshots?.some((snapshot) => snapshot.compressionRecommended) === true,
      signal: options.signal,
      log: options.log,
    });
  }

  const result = options.assembleResult(stageResult, ctx, options.sessionId, options.startedAt, runStopped, memoryAccess);
  if (options.runCheckpointId && typeof result === 'object' && result !== null) {
    (result as { runCheckpointId?: string }).runCheckpointId = options.runCheckpointId;
  }
  return { result, memoryAccess };
}
