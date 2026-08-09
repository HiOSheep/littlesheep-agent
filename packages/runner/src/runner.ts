// @littlesheep/runner — runner.ts
// Shared agent runner: assemble infra from config, expose run().
// Used by the Electron app (local conversations, origin='app') and optional
// channel plugins (channel-routed conversations, origin='channel').
import type {
  AgentResult,
  Message,
  RunContext,
  SessionId,
  SessionMetadata,
  StageResult,
  ToolContext,
  PermissionPolicyId,
  RunConfigOrigin,
  AgentTool,
  RuntimeActiveRunControl,
  RuntimeEventIngress,
  RunCheckpoint,
  ToolStreamEvent,
} from '@littlesheep/types';
import { asSessionId, textMessage } from '@littlesheep/types';
import { randomUUID } from 'node:crypto';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import type { LlmClient } from '@littlesheep/llm';
import type { SessionManager } from '@littlesheep/session';
import {
  buildRunContext,
  clearReplyState,
  writeReplanState,
  writeRuntimeState,
  writeMemoryState,
  writeDecisionState,
} from '@littlesheep/harness';
import { buildInfrastructure, type RunnerState, type LogFn } from './infra.js';
import type { ExecutionLog } from './execution-log.js';
import type { MemoryAccessLedger } from '@littlesheep/memory-tree';
import { getAgentProfile, normalizeAgentProfileId, type AgentProfileId } from '@littlesheep/prompt';
import { reasoningPromptAddon, resolveRunConfig } from './run-config.js';
import { discoverLittleSheepCoreRoots } from './core-source-protection.js';
import type { RunGitCheckpoint } from '@littlesheep/snapshot';
import { beginRuntimeResourceObservation, completeRuntimeResourceObservation } from './runtime-resource-observation.js';
import { ActiveRunRegistry } from './active-run-registry.js';
import { buildRunCheckpoint } from './run-checkpoint.js';
import { RunCheckpointController } from './run-checkpoint-controller.js';
import { createRunCheckpointControl, type RunCheckpointControl } from './run-checkpoint-control.js';
import { createRunAbortControl, resolveRunTimeoutMs } from './run-abort-control.js';
import { describeToolAccess, shouldRequestPermissionApproval } from '@littlesheep/safety';
import { resolveRunTools } from './run-tools.js';
import { runRunnerCoordinator } from './runner-coordinator.js';
import { executeRunnerPhase } from './runner-execute.js';
import { finalizeRunnerPhase } from './runner-finalize.js';
import { persistRunnerPhase } from './runner-persist.js';
/** AgentResult + sessionId (caller-friendly). */
export type RunnerResult = AgentResult & {
  sessionId: SessionId;
  memoryAccess?: MemoryAccessLedger;
  runCheckpointId?: string;
};
interface ContinuationInput {
  checkpoint: RunCheckpoint;
  inbound: Message;
  historyExcludeMessageIds: readonly string[];
  persistInbound: boolean;
}

/** Identifies the call origin — affects execution log archiving and tool approvals. */
export type RunOrigin = RunConfigOrigin;

export interface CreateRunnerOptions {
  config: Config;
  branding: BrandingConfig;
  /** Model ref (provider/model). Defaults to config.agents.defaults.model. */
  model?: string;
  /** Override LLM (tests). */
  llm?: LlmClient;
  /** Override skills dirs. */
  skillsDirs?: string[];
  /** Default approve callback (CLI overrides per-run via run). */
  approve?: ToolContext['approve'];
  /** Directory containing registered identity, philosophy, tool, and memory resources. */
  bootstrapDir?: string;
  /** Host-owned source roots that built-in mutation tools must keep read-only. */
  protectedWriteRoots?: readonly string[];
  /** Active movable application-data root used as the logical LS container. */
  containerRoot?: string;
  /** Host-aware fetch for immutable tokenizer assets (Electron supplies net.fetch for proxy support). */
  tokenizerFetch?: typeof fetch;
  /** Overall run timeout in ms. Defaults to agents.defaults.timeoutSeconds.
   *  The bound applies even when a host also supplies an AbortSignal. 0
   *  disables the timeout. */
  runTimeoutMs?: number;
  /** Hard upper bound for simultaneously registered runtime event queues. */
  maxActiveRuns?: number;
  log?: LogFn;
}

export interface RunInput {
  sessionId?: SessionId;
  text: string;
  cwd?: string;
  signal?: AbortSignal;
  /** Per-run approve override. */
  approve?: ToolContext['approve'];
  /** Call origin. Defaults to 'cli'. */
  origin?: RunOrigin;
  /** When origin==='channel', binds the session to this channel id.
   *  Phase 1: field is accepted but not yet enforced (阶段 3 adds validation). */
  channelId?: string;
  /** External conversation id within the channel (e.g. Telegram chat.id,
   *  QQ group id). Persisted to SessionMetadata when origin==='channel'. */
  externalConversationId?: string;
  /** Optional run id override (default: random UUID from RunContext). */
  runId?: string;
  /** Optional assistant text delta callback for streaming callers. */
  onAssistantDelta?: (delta: string) => void;
  /** Replace provisional streamed text with the approved final reply. */
  onAssistantReplace?: (text: string) => void;
  /** Tool filter function applied before the run. */
  toolFilter?: (tool: { name: string }) => boolean;
  /** Force every available tool through the stage-level approval gate. */
  requireApprovalForAllTools?: boolean;
  /** Permission policy resolved by the owning adapter. */
  permissionPolicyId?: PermissionPolicyId;
  /** Set only when the caller has explicitly approved the initial workspace scan. */
  workspaceAccessApproved?: boolean;
  /** Per-run reasoning budget selected by the user. */
  reasoning?: Config['agents']['defaults']['reasoning'];
  /** General/coding behavior profile. Permission policy is configured separately. */
  profile?: AgentProfileId;
  /** Optional tool event callback for real-time streaming (SSE tool_start/tool_end). */
  onToolEvent?: (evt: import('@littlesheep/types').ToolStreamEvent) => void;
  /** Per-run attachments. Image data URLs are sent to vision-capable models. */
  attachments?: import('@littlesheep/types').RunAttachment[];
  /** Ephemeral tools scoped to this run, such as user-selected attachment readers. */
  additionalTools?: AgentTool[];
  /** Adapter-resolved workspace boundary used by the metadata-only resource index. */
  workspaceContext?: {
    boundaryKind: import('@littlesheep/memory-tree').WorkspaceBoundaryKind;
    projectId?: string;
  };
}

export interface ResumeCheckpointOptions {
  /** Required only when the checkpoint was waiting for a clarification. */
  text?: string;
  /** Human-readable reason retained in the disposition audit. */
  reason?: string;
  /** Host-owned identity published before the resumed stream starts. */
  runId?: string;
  signal?: AbortSignal;
  approve?: ToolContext['approve'];
  onAssistantDelta?: (delta: string) => void;
  onAssistantReplace?: (text: string) => void;
  onToolEvent?: (evt: import('@littlesheep/types').ToolStreamEvent) => void;
}

export interface AgentRunner {
  run(input: RunInput): Promise<RunnerResult>;
  runStream(input: RunInput, onDelta: (delta: string) => void): Promise<RunnerResult>;
  /** Inspect and explicitly continue a durable runtime checkpoint. */
  resumeCheckpoint?(checkpointId: string, options?: ResumeCheckpointOptions): Promise<RunnerResult>;
  /** Bounded application control surface for startup recovery. */
  readonly runCheckpoints?: RunCheckpointControl;
  /** Replay a past run by id (reads execution log). Returns null if not found. */
  replay(runId: string): Promise<ExecutionLog | null>;
  /** Ingress for events targeting an active run; independent from session input. */
  readonly runtimeEvents: RuntimeEventIngress;
  /** Bounded runtime-owned query and control surface for active runs. */
  readonly activeRuns?: RuntimeActiveRunControl;
  shutdown(): Promise<void>;
  readonly state: RunnerState;
  /** Underlying SessionManager — exposed so the app layer can read session history. */
  readonly sessionManager: SessionManager;
  /** Full infrastructure — exposed for memory/skills/experience read access. */
  readonly infra: import('./infra.js').Infrastructure;
  /** Current model ref. */
  readonly model: string;
}

/** Build a runner. Async because the skill loader reads directories. */
export async function createRunner(opts: CreateRunnerOptions): Promise<AgentRunner> {
  const model = opts.model ?? opts.config.agents.defaults.model;
  const state: RunnerState = { sessionId: undefined, model };
  const protectedWriteRoots = opts.protectedWriteRoots
    ?? discoverLittleSheepCoreRoots([process.cwd(), process.argv[1] ?? '']);
  const containerRoot = opts.containerRoot ?? opts.bootstrapDir;
  const infra = await buildInfrastructure({
    config: opts.config,
    branding: opts.branding,
    model,
    llm: opts.llm,
    skillsDirs: opts.skillsDirs,
    bootstrapDir: opts.bootstrapDir,
    tokenizerFetch: opts.tokenizerFetch,
    state,
    log: opts.log,
  });
  const activeRuns = new ActiveRunRegistry({ maxActiveRuns: opts.maxActiveRuns });
  const checkpointController = infra.runCheckpointStore
    ? new RunCheckpointController({
        checkpointStore: infra.runCheckpointStore,
        dispositionStore: infra.runCheckpointDispositionStore,
      })
    : undefined;
  const runCheckpoints = createRunCheckpointControl(checkpointController, infra.runCheckpointStore, model);

  const RUN_TIMEOUT_MS = resolveRunTimeoutMs(opts.runTimeoutMs, opts.config.agents.defaults.timeoutSeconds);

  async function run(input: RunInput, continuation?: ContinuationInput): Promise<RunnerResult> {
    const startedAt = Date.now();
    const runtimeResourceStart = beginRuntimeResourceObservation();
    const runId = input.runId ?? randomUUID();
    const origin = input.origin ?? continuation?.checkpoint.resumeState?.origin ?? 'cli';
    const cwd = input.cwd ?? continuation?.checkpoint.resumeState?.cwd ?? opts.config.agents.defaults.workspace;
    let activeCheckpoint: RunGitCheckpoint | undefined;
    let checkpointCompleted = false;
    let runtimeQueueRegistered = false;
    let runCheckpointId: string | undefined;

    const abortControl = createRunAbortControl({ signal: input.signal, timeoutMs: RUN_TIMEOUT_MS, origin, startedAt });
    const signal = abortControl.signal;

    try {
      activeCheckpoint = await infra.versioning?.beginRun({ runId, workspaceRoot: cwd });
      // 1. Resolve or create session.
      let sessionId: SessionId;
      if (continuation) {
        if (input.sessionId && String(input.sessionId) !== String(continuation.checkpoint.sessionId)) {
          throw new Error('resume session does not match the checkpoint session');
        }
        sessionId = continuation.checkpoint.sessionId;
      } else if (input.sessionId) {
        sessionId = input.sessionId;
      } else {
        // Build metadata for channel-bound sessions so listByChannel() works.
        // origin is also stamped on app/cli sessions for UI provenance.
        // 'test' origin is omitted from metadata (not a user-visible origin).
        const meta: Partial<SessionMetadata> = {};
        if (origin === 'app' || origin === 'channel' || origin === 'cli') {
          meta.origin = origin;
        }
        if (origin === 'channel' && input.channelId) {
          meta.channelId = input.channelId;
          if (input.externalConversationId) {
            meta.externalConversationId = input.externalConversationId;
          }
        }
        const session = await infra.sessionManager.create(model, undefined, meta);
        sessionId = session.id;
      }
      state.sessionId = sessionId;
      const runtimeEventQueue = activeRuns.registerRun(runId, sessionId, continuation?.checkpoint.runtimeEventQueue, abortControl.registration);
      runtimeQueueRegistered = true;
      const onToolEvent = (event: ToolStreamEvent): void => {
        activeRuns.observe(runId, event);
        input.onToolEvent?.(event);
      };

      // 2. Build inbound user message.
      const inbound: Message = continuation
        ? structuredClone({ ...continuation.inbound, sessionId })
        : textMessage('user', input.text, {
            sessionId,
            runId,
            timestamp: new Date(startedAt).toISOString(),
          });

      // 3. Build RunContext (loads history WITHOUT inbound — no duplicate).
      // Apply caller-provided tool policy before the run.
      const runTools = resolveRunTools(infra.registry.list(), {
        additionalTools: input.additionalTools,
        filter: input.toolFilter,
        requireApprovalForAllTools: input.requireApprovalForAllTools,
      });
      const resolvedTools = runTools.tools;
      const toolSources = runTools.sources;

      const behaviorProfile = getAgentProfile(input.profile ?? opts.config.agents.defaults.profile);
      let previousRun: import('@littlesheep/types').SessionRunSummary | undefined;
      try {
        previousRun = await infra.executionLogStore.readLatestForSession(sessionId) ?? undefined;
      } catch (err) {
        opts.log?.('warn', `runner: failed to read last-run timing summary: ${(err as Error).message}`);
      }
      const resolvedRunConfig = resolveRunConfig({
        runId,
        config: opts.config,
        modelRef: model,
        origin,
        profile: behaviorProfile?.id,
        permissionPolicyId: input.permissionPolicyId,
        reasoning: input.reasoning,
        tools: resolvedTools,
        requireApprovalForAllTools: input.requireApprovalForAllTools === true,
        toolFilterApplied: input.toolFilter !== undefined,
        cwdOverridden: input.cwd !== undefined,
      });
      const permissionMode = containerRoot
        ? (input.permissionPolicyId ?? (input.requireApprovalForAllTools ? 'restricted' : 'research'))
        : undefined;
      const workspaceScan = containerRoot
        ? describeToolAccess('read', { path: cwd }, { cwd, containerRoot })
        : undefined;
      const workspaceScanNeedsApproval = permissionMode !== undefined
        && workspaceScan !== undefined
        && shouldRequestPermissionApproval(permissionMode, workspaceScan)
        && input.workspaceAccessApproved !== true;
      if (!workspaceScanNeedsApproval) {
        try {
          await infra.memoryService.syncWorkspaceResources(cwd, input.workspaceContext);
          await infra.memoryService.syncWorkspaceDocuments(cwd);
        } catch (error) {
          opts.log?.('warn', `runner: workspace resource registration degraded: ${(error as Error).message}`);
        }
      } else {
        opts.log?.('info', `runner: deferred workspace indexing until approved access (${workspaceScan?.boundary})`);
      }
      const ctx: RunContext = await buildRunContext({
        sessionId,
        inbound,
        sessionManager: infra.sessionManager,
        memoryStore: infra.memoryStore,
        tools: resolvedTools,
        toolSources,
        config: opts.config,
        branding: opts.branding,
        model,
        runId,
        startedAt: new Date(startedAt).toISOString(),
        previousRun,
        cwd,
        protectedWriteRoots,
        containerRoot,
        permissionMode,
        signal,
        approve: input.approve ?? opts.approve,
        log: opts.log,
        versioning: activeCheckpoint,
        onAssistantDelta: input.onAssistantDelta,
        onAssistantReplace: input.onAssistantReplace,
        onToolEvent,
        profilePromptAddon: behaviorProfile?.systemPromptAddon,
        reasoningPromptAddon: reasoningPromptAddon(resolvedRunConfig.reasoning),
        attachments: input.attachments,
         resolvedRunConfig,
         runtimeEventQueue,
         bootstrapDir: opts.bootstrapDir,
         memoryResources: infra.memoryService,
         workspaceContext: input.workspaceContext,
          historyExcludeMessageIds: continuation?.historyExcludeMessageIds,
       });
      if (continuation) restoreContinuationContext(ctx, continuation.checkpoint);
      ctx.persistRuntimeCheckpoint = async (reason) => {
        if (!infra.runCheckpointStore) return undefined;
        const checkpoint = buildRunCheckpoint({
          ctx,
          stageResult: {
            stage: 'execute',
            next: 'exit',
            ok: false,
            error: reason,
          },
          reason,
        });
        const outcome = await infra.runCheckpointStore.write(checkpoint);
        if (outcome.kind === 'conflict') throw new Error(`run checkpoint id conflict: ${outcome.checkpointId}`);
        runCheckpointId = checkpoint.id;
        return checkpoint.id;
      };
      let usedContinuitySummaryId: string | undefined;
      try {
        await infra.memoryService.registerRunResources({
          runId: ctx.runId,
          sessionId,
          workspace: cwd,
          summary: ctx.sessionSummary,
          attachments: ctx.attachments,
        });
      } catch (err) {
        opts.log?.('warn', `runner: run resource registration degraded: ${(err as Error).message}`);
      }
      try {
        const memoryRun = await infra.memoryService.beginRun({
          runId: ctx.runId,
          sessionId,
          query: input.text,
          recentHistory: ctx.history.map((message) => ({
            role: message.role,
            content: message.content
              .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
              .map((block) => block.text)
              .join('\n'),
          })),
          continuitySummary: ctx.sessionSummary ? {
            id: ctx.sessionSummary.id,
            content: ctx.sessionSummary.summary,
          } : undefined,
          workspace: cwd,
          signal,
        });
        usedContinuitySummaryId = memoryRun.continuitySummaryId;
        const memoryContextWorkingSet = memoryRun.initialContext ? {
            revision: 1,
            activeAtomIds: [...memoryRun.initialContext.atomIds],
            releasedAtomIds: [],
            activeCallByAtom: Object.fromEntries(memoryRun.initialContext.atomIds.map((atomId) => [atomId, 'initial'])),
            callAtomIds: { initial: [...memoryRun.initialContext.atomIds] },
            updatedAt: new Date().toISOString(),
          } : undefined;
        writeMemoryState(ctx, 'runner-init', {
          memoryRootIndex: memoryRun.rootIndex,
          initialMemoryContext: memoryRun.initialContext?.content,
          memoryKnownState: structuredClone(memoryRun.ledger.knownState),
          memoryContextWorkingSet,
        });
      } catch (err) {
        opts.log?.('warn', `runner: memory tree start degraded: ${(err as Error).message}`);
      }

      // 4. Persist inbound AFTER buildRunContext (so it's not in loaded history)
      //    but BEFORE harness.run (so FINALIZE's append of produced goes after
      //    inbound → correct JSONL order: [..., user, assistant]).
      if (!continuation || continuation.persistInbound) {
        try {
          await infra.sessionManager.append(sessionId, [inbound]);
        } catch (err) {
          opts.log?.('error', `runner: failed to persist inbound: ${(err as Error).message}`);
        }
      }

      // 5. Execute the state machine and checkpoint recovery state.
      const prepared = { ctx, sessionId, inboundText: input.text, usedContinuitySummaryId };
      const result = await runRunnerCoordinator<RunContext, RunnerResult, MemoryAccessLedger | undefined>({
        prepare: async () => prepared,
        execute: async (preparedRun) => {
          const executedRun = await executeRunnerPhase({
            ctx: preparedRun.ctx,
            harness: infra.harness,
            signal,
            runCheckpointStore: infra.runCheckpointStore,
            log: opts.log,
            checkpointReason,
            onCheckpointId: (id) => { runCheckpointId = id; },
          });
          return { prepared: preparedRun, ...executedRun, runCheckpointId };
        },
        finalize: async (executedRun) => {
          const finalizedRun = await finalizeRunnerPhase({
            ctx: executedRun.prepared.ctx,
            stageResult: executedRun.stageResult,
            runStopped: executedRun.runStopped,
            sessionId,
            runId: ctx.runId,
            cwd,
            usedContinuitySummaryId,
            signal,
            runCheckpointId,
            startedAt,
            model,
            compact: opts.config.sessions.compaction,
            infra,
            assembleResult,
            log: opts.log,
          });
          return { ...executedRun, result: finalizedRun.result, memoryAccess: finalizedRun.memoryAccess };
        },
        persist: async (finalizedRun) => {
          await persistRunnerPhase({
            result: finalizedRun.result,
            sessionId,
            startedAt,
            inputText: input.text,
            model,
            runCheckpointId,
            runtimeResourceObservation: completeRuntimeResourceObservation(runtimeResourceStart),
            executionLogStore: infra.executionLogStore,
            activeCheckpoint,
            onCheckpointCompleted: (completed) => { checkpointCompleted = completed; },
            log: opts.log,
          });
        },
      });
      return result;
    } finally {
      if (runtimeQueueRegistered) activeRuns.unregister(runId);
      if (activeCheckpoint && !checkpointCompleted) {
        try {
          await activeCheckpoint.abort();
        } catch (err) {
          opts.log?.('error', `runner: failed to freeze interrupted run: ${(err as Error).message}`);
        }
      }
      abortControl.dispose();
    }
  }

  async function resumeCheckpoint(
    checkpointId: string,
    options: ResumeCheckpointOptions = {},
  ): Promise<RunnerResult> {
    if (!checkpointController || !infra.runCheckpointStore) {
      throw new Error('runtime checkpoint continuation is unavailable')
    }
    const checkpoint = await infra.runCheckpointStore.read(checkpointId)
    if (!checkpoint) throw new Error(`run checkpoint not found: ${checkpointId}`)
    const state = checkpoint.resumeState
    if (!state) throw new Error('run checkpoint is inspect-only because it has no resume state')
    const inbound = await infra.sessionManager.findMessage(checkpoint.sessionId, state.inboundMessageId)
    if (!inbound || inbound.role !== 'user') {
      throw new Error('run checkpoint original inbound message is missing or invalid')
    }
    const isClarification = checkpoint.status === 'waiting_user'
    if (isClarification && !options.text?.trim()) {
      throw new Error('run checkpoint is waiting for a user clarification')
    }
    const availableNames = new Set(infra.registry.list().map((item) => item.tool.name))
    const missingTools = state.availableToolNames.filter((name) => !availableNames.has(name))
    if (missingTools.length > 0) {
      throw new Error(`run checkpoint requires unavailable tools: ${missingTools.join(', ')}`)
    }
    const resumeRunId = options.runId?.trim() || randomUUID()
    const claim = await checkpointController.claimResume(
      checkpoint.id,
      options.reason ?? 'user requested checkpoint continuation',
      resumeRunId,
      model,
    )
    if (claim.kind === 'blocked') {
      throw new Error(`run checkpoint cannot be resumed: ${claim.inspection.reasons.join('; ')}`)
    }
    if (claim.kind === 'conflict') throw new Error(`run checkpoint resume conflict: ${claim.message}`)

    const continuationInbound = isClarification
      ? textMessage('user', options.text!.trim(), {
          sessionId: checkpoint.sessionId,
          runId: resumeRunId,
        })
      : structuredClone(inbound)
    try {
      const result = await run({
        sessionId: checkpoint.sessionId,
        text: isClarification ? options.text!.trim() : messageText(inbound),
        cwd: state.cwd,
        runId: resumeRunId,
        origin: state.origin,
        signal: options.signal,
        approve: options.approve ?? opts.approve,
        onAssistantDelta: options.onAssistantDelta,
        onAssistantReplace: options.onAssistantReplace,
        onToolEvent: options.onToolEvent,
        permissionPolicyId: state.permissionPolicyId,
        reasoning: state.reasoning,
        profile: normalizeAgentProfileId(state.behaviorModeId),
        workspaceContext: state.workspaceContext,
      }, {
        checkpoint,
        inbound: continuationInbound,
        historyExcludeMessageIds: [state.inboundMessageId],
        persistInbound: isClarification,
      })
      await checkpointController.completeResume(
        checkpoint.id,
        resumeRunId,
        result.status === 'ok' ? 'ok' : result.status === 'aborted' ? 'aborted' : 'error',
        result.error ?? 'checkpoint continuation completed',
        result.runCheckpointId,
      )
      return result
    } catch (error) {
      await checkpointController.completeResume(
        checkpoint.id,
        resumeRunId,
        options.signal?.aborted ? 'aborted' : 'error',
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined)
      throw error
    }
  }

  return {
    run,
    runStream: (input: RunInput, onDelta: (delta: string) => void) =>
      run({ ...input, onAssistantDelta: onDelta }),
    resumeCheckpoint,
    runCheckpoints,
    replay: (runId: string) => infra.executionLogStore.read(runId),
    runtimeEvents: activeRuns,
    activeRuns,
    shutdown: async () => {
      activeRuns.dispose();
      // Close long-lived SQLite connections before adapters replace or delete the data root.
      await infra.memoryRepository.shutdown();
      await infra.disposeEmbedding();
      await infra.runCheckpointStore?.prune().catch(() => undefined);
      infra.runCheckpointStore?.dispose();
      await infra.runCheckpointDispositionStore.prune().catch(() => undefined);
      infra.runCheckpointDispositionStore.dispose();
      await infra.versioning?.freeze();
    },
    state,
    sessionManager: infra.sessionManager,
    infra,
    model,
  };
}

function checkpointReason(ctx: RunContext, stageResult: StageResult, interrupted: boolean): string {
  if (ctx.runtimeControl?.state === 'paused') return ctx.runtimeControl.reason ?? 'run paused at a safe boundary';
  if (interrupted) return ctx.runtimeControl?.reason ?? 'run interrupted before completion';
  if (ctx.clarificationRequest) return 'run is waiting for user clarification';
  return stageResult.error ?? ctx.lastError?.message ?? 'run requires recovery';
}

function assembleResult(
  stageResult: StageResult,
  ctx: RunContext,
  sessionId: SessionId,
  startedAtMs: number,
  aborted = false,
  memoryAccess?: MemoryAccessLedger,
): RunnerResult {
  const status: AgentResult['status'] = aborted ? 'aborted' : stageResult.ok ? 'ok' : 'error';
  const trace = (stageResult.meta?.trace as AgentResult['trace']) ?? [];
  return {
    runId: ctx.runId,
    sessionId,
    status,
    reply: ctx.reply ?? '',
    replyProvenance: ctx.replyProvenance,
    error: stageResult.error,
    messages: ctx.produced,
    trace,
    durationMs: Date.now() - startedAtMs,
    usage: ctx.usage,
    resolvedRunConfig: ctx.resolvedRunConfig,
    modelRequests: ctx.modelRequests,
    contextSnapshots: ctx.contextSnapshots,
    taskExecution: ctx.taskExecution,
    toolInvocations: ctx.toolInvocations,
    toolInvocationsTruncated: ctx.toolInvocationsTruncated,
    sideEffects: ctx.sideEffects,
    taskBook: ctx.taskBook ? { ...ctx.taskBook, stageResults: undefined } : undefined,
    verificationHistory: ctx.verificationHistory,
    runtimeControl: ctx.runtimeControl,
    runtimeEventQueue: snapshotRuntimeEventQueue(ctx),
    memoryIntentDecisions: ctx.memoryIntentDecisions,
    memoryKnownState: ctx.memoryKnownState,
    memoryContinuityAssessment: ctx.memoryContinuityAssessment,
    clarificationRequest: ctx.clarificationRequest,
    clarificationResponse: ctx.clarificationResponse,
    memoryAccess,
  };
}

function snapshotRuntimeEventQueue(ctx: RunContext) {
  try {
    return ctx.runtimeEventQueue?.snapshot();
  } catch {
    return undefined;
  }
}

function messageText(message: Message): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function restoreContinuationContext(ctx: RunContext, checkpoint: RunCheckpoint): void {
  const state = checkpoint.resumeState;
  if (!state) throw new Error('checkpoint has no resumable runtime state');

  ctx.entryStage = checkpoint.currentStage === 'enter' || checkpoint.currentStage === 'finalize'
    ? checkpoint.currentStage === 'enter' ? 'classify' : 'reply'
    : checkpoint.currentStage;
  ctx.resumedFromCheckpointId = checkpoint.id;
  writeReplanState(ctx, 'runner-restore', {
    taskBook: checkpoint.taskBook ? structuredClone(checkpoint.taskBook) : undefined,
    taskBookRevision: checkpoint.taskBookRevision,
    taskExecution: checkpoint.taskExecution ? structuredClone(checkpoint.taskExecution) : undefined,
    plan: state.plan ? structuredClone(state.plan) : undefined,
    appliedTaskBookPatchIds: [...state.appliedTaskBookPatchIds],
    replanAttempts: state.replanAttempts,
  });
  writeDecisionState(ctx, 'runner-restore', {
    classification: state.classification ? structuredClone(state.classification) : undefined,
    needAssessment: state.needAssessment ? structuredClone(state.needAssessment) : undefined,
  });
  writeRuntimeState(ctx, 'runner-restore', {
    deferredRuntimeEventIds: [...checkpoint.pendingEventIds],
    deferredRuntimeEvents: structuredClone(state.deferredRuntimeEvents),
    loopBudget: structuredClone(checkpoint.loopBudget),
  });
  ctx.sideEffects = structuredClone(checkpoint.sideEffects);
  ctx.modelCallCount = checkpoint.loopBudget.attemptsUsed;
  ctx.recoveryAttempts = state.recoveryAttempts;
  ctx.maxReplanAttempts = state.maxReplanAttempts;
  ctx.verificationHistory = structuredClone(state.verificationHistory);
  // A paused/interrupted control snapshot must not immediately stop the new
  // continuation at its first safe boundary. The original event evidence is
  // retained in the restored queue; the new run starts in a clean state.
  writeRuntimeState(ctx, 'runner-restore', { runtimeControl: undefined });
  ctx.lastError = undefined;
  clearReplyState(ctx, 'runner-restore');
}
