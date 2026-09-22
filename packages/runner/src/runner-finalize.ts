import type { RunContext, SessionId, StageResult } from '@littlesheep/types';
import type { MemoryAccessLedger } from '@littlesheep/memory-tree';
import type { MemoryService } from '@littlesheep/memory-tree';
import { collectConversationSourceRecords } from '@littlesheep/harness';
import { buildMemoryRunFeedbackInput, independentSuccessfulToolCallIds } from './memory-feedback-evidence.js';
import { recordSessionSummaryActivation } from './session-summary-activation.js';
import { compactSessionAfterRun } from './session-continuity.js';
import { memoryRevokedDuringRun } from './session-summary-revocation.js';
import type { SessionCompactionScheduler } from './session-compaction-scheduler.js';

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
  compact: { threshold: number; keepRecent: number; background?: boolean };
  /** Single owner for automatic compaction operations; optional for legacy callers. */
  compactionScheduler?: SessionCompactionScheduler;
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

/**
 * Authoritative conversation-source capture is not best-effort: when it fails the
 * run still settles, but the result must say that source refs may be missing.
 */
export interface MemorySourceCaptureDegradation {
  status: 'degraded';
  reason: string;
}

/** Capture memory evidence, finish the memory run, compact, and assemble the result. */
export async function finalizeRunnerPhase<TResult>(
  options: FinalizeRunnerPhaseOptions<TResult>,
): Promise<FinalizeRunnerPhaseResult<TResult>> {
  const { ctx, stageResult, runStopped } = options;
  let memorySourceCapture: MemorySourceCaptureDegradation | undefined;
  try {
    await options.infra.memoryService.captureConversationSources(collectConversationSourceRecords(ctx));
  } catch (err) {
    const reason = (err as Error).message;
    memorySourceCapture = { status: 'degraded', reason };
    options.log?.('warn', `runner: conversation source capture degraded: ${reason}`);
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

  // A committed correction/forget invalidates summaries produced before it, so
  // the next request does not inject the revoked fact as current memory.
  if (memoryRevokedDuringRun(ctx, stageResult)) {
    try {
      await options.infra.sessionManager.updateMetadata(options.sessionId, {
        memoryRevokedAt: new Date().toISOString(),
      });
    } catch (err) {
      options.log?.('warn', `runner: memory revocation marker degraded: ${(err as Error).message}`);
    }
  }

  // Assemble the run result before derived compaction so its evidence, duration
  // and cost stay the run's own; compaction owns the operation record instead.
  const result = options.assembleResult(stageResult, ctx, options.sessionId, options.startedAt, runStopped, memoryAccess);
  if (options.runCheckpointId && typeof result === 'object' && result !== null) {
    (result as { runCheckpointId?: string }).runCheckpointId = options.runCheckpointId;
  }
  if (memorySourceCapture && typeof result === 'object' && result !== null) {
    (result as { memorySourceCapture?: MemorySourceCaptureDegradation }).memorySourceCapture = memorySourceCapture;
  }

  if (!runStopped) {
    const snapshots = ctx.contextSnapshots ?? [];
    const force = snapshots.some((snapshot) => snapshot.compressionRecommended);
    // When the model's context budget is known, only real occupancy pressure may
    // start a compaction. Compaction rewrites the transcript, so the next request
    // re-bills the whole prefix: measured on the 28-turn long task, six
    // message-count compactions cost 288,536 re-billed tokens against 28,857
    // tokens of genuinely new input, on a session whose prompts never exceeded 26k
    // of a 128k window. A model whose window is unknown keeps the message count as
    // the only trigger available.
    const budgetKnown = snapshots.some((snapshot) => snapshot.budget?.status === 'known');
    const threshold = budgetKnown ? Number.MAX_SAFE_INTEGER : options.compact.threshold;
    const compaction = {
      sessionManager: options.infra.sessionManager,
      memoryService: options.infra.memoryService,
      llm: options.infra.llm,
      sessionId: options.sessionId,
      runId: options.runId,
      workspace: options.cwd,
      model: ctx.resolvedRunConfig?.model ?? options.model,
      threshold,
      keepRecent: options.compact.keepRecent,
      force,
      signal: options.signal,
      scheduler: options.compactionScheduler,
      log: options.log,
    };
    if (options.compact.background === true && !force) {
      // Soft automatic compaction may outlive the run: give it a detached
      // accounting context so it cannot mutate the published run or its usage.
      void compactSessionAfterRun({ ...compaction, ctx: detachedCompactionContext(ctx) })
        .catch((error: unknown) => {
          options.log?.('warn', `runner: background session compaction failed: ${(error as Error).message}`);
        });
    } else {
      await compactSessionAfterRun({ ...compaction, ctx });
    }
  }

  return { result, memoryAccess };
}

/** Independent request/usage arrays so background work cannot rewrite the run result. */
function detachedCompactionContext(ctx: RunContext): RunContext {
  return {
    ...ctx,
    appendDurableEvent: undefined,
    deferFinalReplySettlement: false,
    streamModelTranscript: false,
    modelRequests: [],
    contextSnapshots: [],
    usage: undefined,
  };
}
