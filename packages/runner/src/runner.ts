// @littlesheep/runner — runner.ts
// Shared agent runner: assemble infra from config, expose run().
// Used by the Electron app (local conversations, origin='app') and optional
// channel plugins (channel-routed conversations, origin='channel').
import {
  filterAuthoritativeUserFacingMessages,
} from '@littlesheep/types';
import type {
  AgentResult,
  Message,
  RunContext,
  SessionId,
  SessionMetadata,
  ToolContext,
  PermissionPolicyId,
  RunConfigOrigin,
  AgentTool,
  RuntimeActiveRunControl,
  RuntimeEventIngress,
  RunCheckpoint,
  ToolStreamEvent,
  ClarificationRequest,
  StageName,
  RunAttachment,
  RunCheckpointContinuationDisposition,
  ConversationContinuationEvidence,
  DurableFinalReplyReplay,
  DurableRunRecoveryResult,
  FinalReplyReservation,
  FinalReplySettlement,
} from '@littlesheep/types';
import { asSessionId, sanitizeWebEvidenceProjection, textMessage } from '@littlesheep/types';
import { randomUUID } from 'node:crypto';
import { parseModelRef, type Config } from '@littlesheep/config';
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
  writeFailureState,
  replaceSideEffectEvidence,
  writeModelObservabilityState,
  flushModelRequestLifecycles,
  reduceDurableRunProjection,
  DurableHarnessKernel,
  collectConversationSourceRecords,
  settleDeferredFinalReply,
} from '@littlesheep/harness';
import { buildInfrastructure, type Infrastructure, type RunnerState, type LogFn } from './infra.js';
import type { ExecutionLog } from './execution-log.js';
import type { MemoryAccessLedger } from '@littlesheep/memory-tree';
import { getAgentProfile, normalizeAgentProfileId, type AgentProfileId } from '@littlesheep/prompt';
import { reasoningPromptAddon, resolveRunConfig } from './run-config.js';
import { discoverLittleSheepCoreRoots } from './core-source-protection.js';
import type { RunGitCheckpoint } from '@littlesheep/snapshot';
import { beginRuntimeResourceObservation, completeRuntimeResourceObservation } from './runtime-resource-observation.js';
import { ActiveRunRegistry } from './active-run-registry.js';
import { buildRunCheckpoint } from './run-checkpoint.js';
import { RunCheckpointController, type WaitingUserHeadResolution } from './run-checkpoint-controller.js';
import { createRunCheckpointControl, type RunCheckpointControl } from './run-checkpoint-control.js';
import { createRunAbortControl, resolveRunTimeoutMs } from './run-abort-control.js';
import { describeToolAccess, shouldRequestPermissionApproval } from '@littlesheep/safety';
import { resolveRunTools } from './run-tools.js';
import { buildRunnerCapabilityState } from './capability-snapshot.js';
import { runRunnerCoordinator } from './runner-coordinator.js';
import { executeRunnerPhase } from './runner-execute.js';
import { finalizeRunnerPhase } from './runner-finalize.js';
import { persistRunnerPhase, RunnerPersistenceError } from './runner-persist.js';
import { prepareAuthoritativeRunnerResult } from './authoritative-reply.js';
import { resolveSemanticResumeStage } from './continuation-stage.js';
import { WebRetrievalRuntime } from '@littlesheep/web';
import { createCacheObservationPersistence } from './cache-observation-runtime.js';
import {
  resolveContinuationDisposition,
  type ContinuationDirective,
  type ContinuationDispositionDecision,
} from './continuation-disposition.js';
import {
  conversationTurnInputDigest,
  conversationTurnMessageId,
  conversationTurnRunId,
} from './conversation-turn.js';
import {
  DurableRunRecorder,
  createDurableRunRecorder,
  recordDurableRunOutcome,
  recordDurableUserInput,
  durableTextDigest,
} from './durable-run-recorder.js';
import {
  assembleResult,
  checkpointReason,
  messageText,
  resolveConversationContinuationMode,
} from './runner-support.js';
/** AgentResult + sessionId (caller-friendly). */
export type RunnerResult = AgentResult & {
  sessionId: SessionId;
  memoryAccess?: MemoryAccessLedger;
  runCheckpointId?: string;
  /** Effective durable Harness mode for this run (global or session override). */
  durableHarnessMode?: 'shadow' | 'next';
};
interface ContinuationInput {
  checkpoint: RunCheckpoint;
  inbound: Message;
  historyExcludeMessageIds: readonly string[];
  persistInbound: boolean;
  resumeStage: StageName;
  restoreState?: boolean;
  revisionFeedback?: string;
}

interface ConversationTurnCallbacks {
  onAssistantDelta?: (delta: string) => void;
  onAssistantReplace?: (text: string) => void;
  onToolEvent?: (event: ToolStreamEvent) => void;
}

interface CoordinatedConversationTurn {
  inputDigest: string;
  promise: Promise<RunnerResult>;
  settled: boolean;
  callbacks: {
    delta: Set<(delta: string) => void>;
    replace: Set<(text: string) => void>;
    tool: Set<(event: ToolStreamEvent) => void>;
  };
}

class ContinuationControlError extends Error {
  constructor(
    message: string,
    readonly evidence: ConversationContinuationEvidence,
  ) {
    super(message);
    this.name = 'ContinuationControlError';
  }
}

const MAX_RETAINED_CONVERSATION_TURNS = 256;

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
  /** Rollout gate for ordinary-chat checkpoint binding. Defaults to `full`. */
  conversationContinuationMode?: 'off' | 'shadow' | 'full';
  /** Durable Harness rollout mode. Defaults to observational `shadow`. */
  durableHarnessMode?: 'shadow' | 'next';
  /** Per-session durable Harness overrides; unlisted sessions use durableHarnessMode. */
  durableHarnessSessionOverrides?: Readonly<Record<string, 'shadow' | 'next'>>;
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
  /** Stable adapter-owned key used to deduplicate a retried conversation turn. */
  requestKey?: string;
  /** Trusted host callback for rebuilding path-free checkpoint resources. */
  restoreCheckpointResources?: CheckpointResourceResolver;
  /** Bound-turn semantic override. Ordinary chat uses the constrained auto resolver. */
  continuationDirective?: ContinuationDirective;
}

export interface RestoredCheckpointResources {
  attachments?: RunAttachment[];
  additionalTools?: AgentTool[];
}

export type CheckpointResourceResolver = (
  checkpoint: RunCheckpoint,
  current: RestoredCheckpointResources,
) => Promise<RestoredCheckpointResources>;

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
  origin?: RunOrigin;
  cwd?: string;
  permissionPolicyId?: PermissionPolicyId;
  reasoning?: Config['agents']['defaults']['reasoning'];
  profile?: AgentProfileId;
  workspaceContext?: RunInput['workspaceContext'];
  workspaceAccessApproved?: boolean;
  requireApprovalForAllTools?: boolean;
  toolFilter?: RunInput['toolFilter'];
  attachments?: RunAttachment[];
  additionalTools?: AgentTool[];
  restoreCheckpointResources?: CheckpointResourceResolver;
  requestKey?: string;
  continuationDirective?: ContinuationDirective;
}

interface AuthoritativeResumeCheckpointOptions extends ResumeCheckpointOptions {
  /** Coordinator-owned digest shared by persistence and replay. */
  authoritativeTurnInputDigest?: string;
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
  /** Replay only a durable final settlement; proposals are never exposed. */
  replayDurableFinalReply?(sessionId: SessionId, runId: string): Promise<DurableFinalReplyReplay>;
  /** Perform one conservative post-crash recovery pass without model/tool I/O. */
  recoverDurableRun?(sessionId: SessionId, runId: string): Promise<DurableRunRecoveryResult>;
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
  /** Harness rollout mode used by the runner; legacy callers omit this field. */
  readonly durableHarnessMode?: 'shadow' | 'next';
  /** Resolve the effective mode for one session, including overrides. */
  durableHarnessModeForSession?(sessionId: string): 'shadow' | 'next';
}

/** Build a runner. Async because the skill loader reads directories. */
export async function createRunner(opts: CreateRunnerOptions): Promise<AgentRunner> {
  const model = opts.model ?? opts.config.agents.defaults.model;
  const providerModel = parseModelRef(model).model;
  const conversationContinuationMode = resolveConversationContinuationMode(
    opts.conversationContinuationMode ?? process.env.LITTLESHEEP_CONVERSATION_CONTINUATION_MODE,
  );
  const resolveDurableHarnessMode = (sessionId?: string): 'shadow' | 'next' => (
    (sessionId ? opts.durableHarnessSessionOverrides?.[sessionId] : undefined)
    ?? opts.durableHarnessMode
    ?? 'shadow'
  );
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
  // One Runner-owned kernel is shared by replay/recovery callers. Active runs
  // still serialize their own recorder appends; the durable event store is the
  // cross-process ordering boundary and recovery remains fail-closed on races.
  const durableKernel = new DurableHarnessKernel({
    eventStore: infra.durableEventStore,
    inboxStore: infra.durableInboxStore,
    reserveFinalReply: (sessionId, reservation) => infra.sessionManager.reserveAssistantReplySettlement(
      asSessionId(sessionId),
      reservation,
    ),
  });
  const activeRuns = new ActiveRunRegistry({ maxActiveRuns: opts.maxActiveRuns });
  const conversationTurns = new Map<string, CoordinatedConversationTurn>();
  const checkpointController = infra.runCheckpointStore
    ? new RunCheckpointController({
        checkpointStore: infra.runCheckpointStore,
        dispositionStore: infra.runCheckpointDispositionStore,
      })
    : undefined;
  const runCheckpoints = createRunCheckpointControl(
    checkpointController,
    infra.runCheckpointStore,
    infra.executionLogStore,
    model,
  );

  const RUN_TIMEOUT_MS = resolveRunTimeoutMs(opts.runTimeoutMs, opts.config.agents.defaults.timeoutSeconds);

  async function executeRun(
    input: RunInput,
    continuation?: ContinuationInput,
    continuationEvidence: ConversationContinuationEvidence = { version: 1, resolution: 'none' },
  ): Promise<RunnerResult> {
    const startedAt = Date.now();
    // A real Agent run may need exact model framing. Warm verified assets in
    // parallel with session/context assembly; Context Engine remains protected
    // by its conservative estimator until the counter becomes ready.
    void infra.prepareTokenCounter?.().catch(() => undefined);
    const runtimeResourceStart = beginRuntimeResourceObservation();
    const runId = input.runId ?? randomUUID();
    const origin = input.origin ?? continuation?.checkpoint.resumeState?.origin ?? 'cli';
    const cwd = input.cwd ?? continuation?.checkpoint.resumeState?.cwd ?? opts.config.agents.defaults.workspace;
    let activeCheckpoint: RunGitCheckpoint | undefined;
    let checkpointCompleted = false;
    let runtimeQueueRegistered = false;
    let runCheckpointId: string | undefined;
    let webRetrievalRuntime: WebRetrievalRuntime | undefined;
    let durableRecorder: DurableRunRecorder | undefined;
    let durableOutcomeRecorded = false;
    let runContext: RunContext | undefined;

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
      const durableHarnessMode = resolveDurableHarnessMode(String(sessionId));
      durableRecorder = createDurableRunRecorder({
        eventStore: infra.durableEventStore,
        inboxStore: infra.durableInboxStore,
        sessionId: String(sessionId), runId, origin, model,
        mode: durableHarnessMode,
        initializationError: infra.durableHarnessInitializationError,
        reserveFinalReply: (replySessionId, reservation) => infra.sessionManager.reserveAssistantReplySettlement(
          asSessionId(replySessionId), reservation,
        ),
        log: opts.log,
      });
      await durableRecorder.ready;
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
            ...(conversationTurnMessageId(sessionId, input.requestKey)
              ? { id: conversationTurnMessageId(sessionId, input.requestKey) }
              : {}),
            sessionId,
            runId,
            timestamp: new Date(startedAt).toISOString(),
          });
      await recordDurableUserInput(durableRecorder, origin, runId, inbound);

      // 3. Build RunContext (loads history WITHOUT inbound — no duplicate).
      // Apply caller-provided tool policy before the run.
      const selectedWebProviderSnapshot = opts.config.web.defaultProvider
        ? infra.webProviderSnapshots.find((snapshot) => snapshot.id === opts.config.web.defaultProvider)
        : undefined;
      const webToolsAvailable = opts.config.web.enabled
        && opts.config.web.readMode !== 'disabled'
        && Boolean(opts.config.web.defaultProvider)
        && Boolean(infra.webProviders.get(opts.config.web.defaultProvider))
        && (selectedWebProviderSnapshot?.status === 'configured_unchecked'
          || selectedWebProviderSnapshot?.status === 'ready'
          || selectedWebProviderSnapshot?.status === 'degraded');
      const runRegistrations = infra.registry.list().filter(({ tool }) => (
        webToolsAvailable || (tool.name !== 'web_search' && tool.name !== 'web_fetch')
      ));
      const runTools = resolveRunTools(runRegistrations, {
        additionalTools: input.additionalTools,
        filter: (tool) => (
          (webToolsAvailable || (tool.name !== 'web_search' && tool.name !== 'web_fetch'))
          && (input.toolFilter?.(tool) ?? true)
        ),
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
        webProviderSnapshot: selectedWebProviderSnapshot,
      });
      const selectedProviderStatus = resolvedRunConfig.webProvider?.status;
      const selectedProvider = resolvedRunConfig.networkPolicy?.providerId
        ? infra.webProviders.get(resolvedRunConfig.networkPolicy.providerId)
        : undefined;
      if (
        resolvedRunConfig.networkPolicy?.enabled
        && selectedProvider
        && (selectedProviderStatus === 'configured_unchecked'
          || selectedProviderStatus === 'ready'
          || selectedProviderStatus === 'degraded')
      ) {
        webRetrievalRuntime = new WebRetrievalRuntime({
          runId,
          policy: resolvedRunConfig.networkPolicy,
          providers: infra.webProviders,
          signal,
          cache: infra.webCache,
          log: opts.log,
        });
      }
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
      const { snapshot: capabilitySnapshot, permissionEvent: capabilityPermissionEvent } = buildRunnerCapabilityState({
        tools: resolvedTools, toolSources, approvalRequiredToolNames: resolvedRunConfig.approvalRequiredToolNames,
        permissionPolicyId: resolvedRunConfig.permissionPolicyId,
        workspaceAccess: !containerRoot ? 'unavailable' : workspaceScan?.hardDecision === 'deny' ? 'denied' : workspaceScanNeedsApproval ? 'approval_required' : 'available',
        networkEnabled: resolvedRunConfig.networkPolicy?.enabled === true, webProvider: resolvedRunConfig.webProvider,
        now: new Date(startedAt), permissionEventId: `${runId}:workspace-scan-permission`,
      });
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
        appendDurableEvent: durableRecorder
          ? (event) => durableRecorder!.appendObserved(event)
          : undefined,
        deferFinalReplySettlement: durableHarnessMode === 'next',
        cacheObservationKey: infra.cacheObservationKey,
        persistCacheObservation: createCacheObservationPersistence(infra.cacheObservationStore, {
          sessionId: String(sessionId),
          workspaceScope: cwd,
          permissionPolicyId: resolvedRunConfig.permissionPolicyId,
          key: infra.cacheObservationKey,
        }, opts.log),
        capabilitySnapshot,
        capabilityPermissionEvent,
        runtimeEventQueue,
        bootstrapDir: opts.bootstrapDir,
        memoryResources: infra.memoryService,
        workspaceContext: input.workspaceContext,
          historyExcludeMessageIds: continuation?.historyExcludeMessageIds,
          webRetrieval: webRetrievalRuntime,
        });
      runContext = ctx;
      onToolEvent({
        type: 'capability_snapshot',
        visibility: 'silent',
        capabilitySnapshot,
        permissionEvent: capabilityPermissionEvent,
      });
      if (continuation) {
        if (continuation.restoreState === false) {
          ctx.entryStage = continuation.resumeStage;
          ctx.resumedFromCheckpointId = continuation.checkpoint.id;
          clearReplyState(ctx, 'runner-restore');
        } else {
          restoreContinuationContext(ctx, continuation.checkpoint, continuation.resumeStage);
          if (continuation.revisionFeedback) {
            writeReplanState(ctx, 'runner-restore', {
              verifyFeedback: continuation.revisionFeedback,
              partialReplanRequest: undefined,
            });
          }
        }
      }
      writeRuntimeState(ctx, continuation ? 'runner-restore' : 'runner-init', {
        conversationContinuation: structuredClone(continuationEvidence),
      });
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
        await ctx.appendDurableEvent?.({
          type: 'checkpoint_written',
          source: 'runtime',
          eventId: `${ctx.runId}:checkpoint:${checkpoint.id}`,
          idempotencyKey: `${ctx.runId}:checkpoint:${checkpoint.id}`,
          payload: {
            checkpointId: checkpoint.id,
            reasonHash: durableTextDigest(reason),
            reasonLength: reason.length,
            stage: 'execute',
          },
        });
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
          recentHistory: filterAuthoritativeUserFacingMessages(ctx.history).map((message) => ({
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
          const stableTurn = Boolean(input.requestKey?.trim()) || Boolean(continuation)
          if (stableTurn) {
            const appended = await infra.sessionManager.appendIfAbsent(sessionId, [inbound], inbound.id)
            if (!appended) {
              const existing = await infra.sessionManager.findMessage(sessionId, inbound.id)
              if (!existing || existing.role !== 'user' || messageText(existing) !== messageText(inbound)) {
                throw new Error('conversation request key conflicts with a different persisted message')
              }
              throw new Error('conversation turn was already accepted; refusing to replay its side effects')
            }
          } else {
            await infra.sessionManager.append(sessionId, [inbound]);
          }
        } catch (err) {
          opts.log?.('error', `runner: failed to persist inbound: ${(err as Error).message}`);
          throw err
        }
      }

      // 5. Execute the state machine and checkpoint recovery state.
      const prepared = { ctx, sessionId, inboundText: input.text, usedContinuitySummaryId };
      let result: RunnerResult;
      try {
        result = await runRunnerCoordinator<RunContext, RunnerResult, MemoryAccessLedger | undefined>({
          prepare: async () => prepared,
          execute: async (preparedRun) => {
            const executedRun = await executeRunnerPhase({
              ctx: preparedRun.ctx,
              harness: durableHarnessMode === 'next' ? infra.nextHarness : infra.harness,
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
            if (durableHarnessMode === 'next') {
              // FINALIZE/compaction may prepare one last model request. Close
              // that lifecycle before the audit receipt and final settlement.
              await flushModelRequestLifecycles(ctx);
            }
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
              strict: durableHarnessMode === 'next',
              onCheckpointCompleted: (completed) => { checkpointCompleted = completed; },
              log: opts.log,
            });
          },
        });
      } catch (error) {
        if (durableHarnessMode !== 'next') throw error;
        const reason = error instanceof RunnerPersistenceError
          ? 'finalize_persistence_failed'
          : 'finalize_publication_failed';
        await settleRuntimeFailureEvent(ctx, reason, opts.log);
        const failure = assembleResult({
          stage: 'finalize',
          next: 'exit',
          ok: false,
          error: reason,
        }, ctx, sessionId, startedAt, false, undefined);
        result = runtimeFailureResult(failure, reason);
      }

      // Post-finalize work (notably session compaction) can prepare additional
      // model requests. Close every lifecycle before the terminal run event so
      // replay never observes a completed run with a pending request. In the
      // next path this is also part of the pre-settlement publication gate.
      try {
        await flushModelRequestLifecycles(ctx);
      } catch (error) {
        if (durableHarnessMode !== 'next') throw error;
        const reason = 'finalize_model_lifecycle_failed';
        await settleRuntimeFailureEvent(ctx, reason, opts.log);
        result = runtimeFailureResult(result, reason);
      }

      if (durableHarnessMode === 'next' && result.status === 'ok') {
        try {
          await settleDeferredFinalReply(ctx);
          result = settledReplyResult(result, ctx);
          await settleFinalReplyArtifacts(ctx, infra, opts.log);
        } catch {
          // Do not append a competing Runtime terminal event after either an
          // uncertain or confirmed final-reply event. Recovery will retry the
          // missing cross-store step and then append run_completed.
          if (!ctx.finalReplySettlementUncertain && !ctx.finalReplyEventSettled) {
            await settleRuntimeFailureEvent(ctx, 'final_reply_settlement_failed', opts.log);
          }
          result = runtimeFailureResult(result, 'final_reply_settlement_failed');
          if (ctx.finalReplySettlementUncertain || ctx.finalReplyEventSettled) {
            durableOutcomeRecorded = true;
          }
        }
      }
      if (!durableOutcomeRecorded) {
        try {
          await recordDurableRunOutcome(durableRecorder, result);
        } catch (error) {
          if (durableHarnessMode !== 'next') throw error;
          // The final settlement is already durable. A missing terminal
          // run_completed receipt is repaired by recoverDurableRun; do not
          // downgrade it to a conflicting Runtime failure event.
          opts.log?.('error', `runner: failed to append durable run completion: ${(error as Error).message}`);
        }
        durableOutcomeRecorded = true;
      }
      if (result.status === 'ok' && runCheckpointId && checkpointController) {
        try {
          const outcome = await checkpointController.completeSourceRun(
            runCheckpointId,
            runId,
            'source run completed successfully',
          );
          if (outcome?.kind === 'conflict') {
            opts.log?.('warn', `runner: completed run checkpoint disposition conflict: ${outcome.message}`);
          }
        } catch (error) {
          // The execution log is already durable and startup reconciliation can
          // repair this marker without turning a successful user run into an error.
          opts.log?.('error', `runner: failed to seal completed run checkpoint: ${(error as Error).message}`);
        }
      }
      return { ...result, durableHarnessMode };
    } finally {
      if (durableRecorder && !durableOutcomeRecorded) {
        if (runContext) {
          await flushModelRequestLifecycles(runContext).catch((error) => {
            opts.log?.('error', `runner: model request lifecycle flush during cleanup failed: ${(error as Error).message}`);
          });
        }
        await recordDurableRunOutcome(durableRecorder, {
          status: signal.aborted ? 'aborted' : 'error',
          error: 'run ended before the coordinator produced a settled result',
        });
      } else if (runContext) {
        await flushModelRequestLifecycles(runContext).catch((error) => {
          opts.log?.('error', `runner: model request lifecycle cleanup failed: ${(error as Error).message}`);
        });
      }
      await durableRecorder?.flushBestEffort();
      webRetrievalRuntime?.dispose();
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

  async function runAuthoritative(
    input: RunInput,
    authoritativeTurnInputDigest?: string,
  ): Promise<RunnerResult> {
    const turnId = input.sessionId ? conversationTurnMessageId(input.sessionId, input.requestKey) : undefined
    const baseEvidence: ConversationContinuationEvidence = {
      version: 1,
      resolution: 'none',
      ...(turnId ? { turnId } : {}),
      ...(authoritativeTurnInputDigest
        ? { inputDigest: authoritativeTurnInputDigest }
        : turnId && input.sessionId && input.requestKey
        ? { inputDigest: conversationTurnInputDigest({
            sessionId: input.sessionId,
            requestKey: input.requestKey,
            text: input.text,
            cwd: input.cwd,
            origin: input.origin,
            permissionPolicyId: input.permissionPolicyId,
            reasoning: input.reasoning,
            profile: input.profile,
            attachments: input.attachments,
          }) }
        : {}),
    }
    if (!checkpointController || !input.sessionId || conversationContinuationMode === 'off') {
      return executeRun(input, undefined, baseEvidence)
    }
    const resolution = await checkpointController.resolveWaitingUserHead(input.sessionId, model)
    if (conversationContinuationMode === 'shadow') {
      return executeRun(input, undefined, shadowContinuationEvidence(
        baseEvidence,
        resolution,
        input.permissionPolicyId ?? 'research',
      ))
    }
    if (resolution.kind === 'none') return executeRun(input, undefined, baseEvidence)
    if (resolution.kind === 'blocked') {
      if (await canJoinActiveContinuation(resolution.inspection.disposition, input)) {
        return waitForConversationTurnResult(input.runId!, input.sessionId, input.text, input.signal)
      }
      const resourceBlocked = resolution.reasons.some((reason) => (
        reason.includes('attachment') || reason.includes('resource') || reason.includes('tool')
      ))
      throw new ContinuationControlError(
        `waiting task cannot continue: ${resolution.reasons.join('; ')}`,
        continuationFailureEvidence({
          input,
          resolution: 'blocked',
          checkpoint: resolution.inspection.checkpoint,
          code: resourceBlocked ? 'resource_restore_failed' : 'checkpoint_not_resumable',
          detail: resolution.reasons.join('; '),
          recoverable: true,
          ...(resourceBlocked ? { resourceStatus: 'failed' as const } : {}),
        }),
      )
    }
    if (resolution.kind === 'conflict') {
      throw new ContinuationControlError(
        `multiple waiting tasks require explicit selection: ${resolution.checkpointIds.join(', ')}`,
        continuationFailureEvidence({
          input,
          resolution: 'conflict',
          candidateCheckpointIds: resolution.checkpointIds,
          code: 'multiple_waiting_heads',
          detail: 'multiple waiting-user checkpoints require explicit selection',
          recoverable: true,
        }),
      )
    }
    return resumeCheckpointAuthoritative(resolution.checkpointId, {
      text: input.text,
      reason: 'ordinary conversation turn bound to the session waiting-user checkpoint',
      runId: input.runId,
      signal: input.signal,
      approve: input.approve,
      onAssistantDelta: input.onAssistantDelta,
      onAssistantReplace: input.onAssistantReplace,
      onToolEvent: input.onToolEvent,
      origin: input.origin,
      cwd: input.cwd,
      permissionPolicyId: input.permissionPolicyId,
      reasoning: input.reasoning,
      profile: input.profile,
      workspaceContext: input.workspaceContext,
      workspaceAccessApproved: input.workspaceAccessApproved,
      requireApprovalForAllTools: input.requireApprovalForAllTools,
      toolFilter: input.toolFilter,
      attachments: input.attachments,
      additionalTools: input.additionalTools,
      restoreCheckpointResources: input.restoreCheckpointResources,
      requestKey: input.requestKey,
      continuationDirective: input.continuationDirective ?? 'auto',
      authoritativeTurnInputDigest,
    })
  }

  async function resumeCheckpointAuthoritative(
    checkpointId: string,
    options: AuthoritativeResumeCheckpointOptions = {},
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
    const clarificationRequest = isClarification
      ? await resolveCheckpointClarification(infra.sessionManager, checkpoint)
      : undefined
    if (isClarification && !clarificationRequest) {
      throw new Error('run checkpoint waiting-user clarification request is missing or no longer pending')
    }
    const answerText = options.text?.trim()
    const answerMessageId = isClarification
      ? conversationTurnMessageId(checkpoint.sessionId, options.requestKey)
      : undefined
    const existingAnswer = answerMessageId
      ? await infra.sessionManager.findMessage(checkpoint.sessionId, answerMessageId)
      : undefined
    if (existingAnswer && (existingAnswer.role !== 'user' || messageText(existingAnswer) !== answerText)) {
      throw new Error('continuation request key conflicts with a different persisted answer')
    }
    const priorInspection = await checkpointController.inspect(checkpoint.id, model)
    const priorDisposition = priorInspection?.disposition
    const repeatsDurableClaim = Boolean(
      isClarification
      && answerMessageId
      && options.requestKey
      && priorDisposition?.requestId === clarificationRequest!.id
      && priorDisposition.answerMessageId === answerMessageId
      && priorDisposition.requestKey === options.requestKey,
    )
    if (repeatsDurableClaim && priorDisposition?.status === 'resuming' && priorDisposition.resumeRunId) {
      return waitForConversationTurnResult(
        priorDisposition.resumeRunId,
        checkpoint.sessionId,
        answerText!,
        options.signal,
      )
    }
    const sameInterruptedClaim = Boolean(
      repeatsDurableClaim
      && priorDisposition?.status === 'interrupted'
    )
    let recoveryCheckpoint = checkpoint
    if (sameInterruptedClaim && priorDisposition?.nextCheckpointId) {
      const linkedInspection = await checkpointController.inspect(priorDisposition.nextCheckpointId, model)
      if (!linkedInspection) {
        throw new ContinuationControlError(
          'linked continuation checkpoint is missing after process restart',
          continuationFailureEvidence({
            input: resumeTurnInput(checkpoint, options, answerText!),
            resolution: 'blocked',
            checkpoint,
            candidateCheckpointIds: [priorDisposition.nextCheckpointId],
            requestId: clarificationRequest?.id,
            answerMessageId,
            code: 'checkpoint_not_resumable',
            detail: 'the continuation checkpoint recorded before the crash is missing',
            recoverable: true,
          }),
        )
      }
      if (!linkedInspection.resumable) {
        const detail = linkedInspection.reasons.join('; ')
        throw new ContinuationControlError(
          `linked continuation checkpoint cannot be resumed: ${detail}`,
          continuationFailureEvidence({
            input: resumeTurnInput(checkpoint, options, answerText!),
            resolution: 'blocked',
            checkpoint,
            candidateCheckpointIds: [linkedInspection.checkpoint.id],
            requestId: clarificationRequest?.id,
            answerMessageId,
            code: 'checkpoint_not_resumable',
            detail,
            recoverable: true,
          }),
        )
      }
      recoveryCheckpoint = linkedInspection.checkpoint
    }
    if (existingAnswer && !sameInterruptedClaim) {
      throw new Error('conversation turn was already consumed by another task state; refusing to bind it again')
    }

    let dispositionDecision: ContinuationDispositionDecision | undefined
    if (isClarification) {
      dispositionDecision = sameInterruptedClaim && priorDisposition?.continuationDisposition
        ? {
            kind: priorDisposition.continuationDisposition,
            source: 'runtime_fallback',
            reason: 'reused the durable disposition from the interrupted claim',
          }
        : await resolveContinuationDisposition({
            llm: infra.llm,
            model: providerModel,
            checkpoint,
            request: clarificationRequest!,
            answer: answerText!,
            directive: options.continuationDirective ?? 'auto',
            signal: options.signal,
          })
      if (dispositionDecision.kind === 'ambiguous') {
        const detail = dispositionDecision.reason ?? 'choose answer, retry, revise goal, cancel, or new task explicitly'
        throw new ContinuationControlError(
          `waiting task response is ambiguous and was not claimed: ${detail}`,
          continuationFailureEvidence({
            input: resumeTurnInput(checkpoint, options, answerText!),
            resolution: 'blocked',
            checkpoint,
            requestId: clarificationRequest!.id,
            answerMessageId,
            code: 'ambiguous_disposition',
            detail,
            recoverable: true,
          }),
        )
      }
    }

    const claimIdentity = isClarification && options.requestKey && answerMessageId
      ? {
          requestId: clarificationRequest!.id,
          answerMessageId,
          requestKey: options.requestKey,
          continuationDisposition: dispositionDecision!.kind as RunCheckpointContinuationDisposition,
        }
      : undefined
    const continuationInbound = isClarification
      ? textMessage('user', answerText!, {
          ...(answerMessageId ? { id: answerMessageId } : {}),
          sessionId: checkpoint.sessionId,
          runId: options.runId?.trim() || randomUUID(),
          clarificationResponse: {
            requestId: clarificationRequest!.id,
            answer: answerText!,
            answeredAt: existingAnswer?.timestamp ?? new Date().toISOString(),
          },
        })
      : structuredClone(inbound)

    if (dispositionDecision?.kind === 'cancel') {
      const outcome = await checkpointController.abandon(
        checkpoint.id,
        dispositionDecision.reason ?? 'user cancelled the waiting task',
        claimIdentity,
      )
      if (outcome.kind === 'conflict') throw new Error(`run checkpoint cancellation conflict: ${outcome.message}`)
      const cancellationRunId = options.runId?.trim() || continuationInbound.runId || randomUUID()
      continuationInbound.runId = cancellationRunId
      return executeRun({
        sessionId: checkpoint.sessionId,
        text: answerText!,
        cwd: options.cwd ?? state.cwd,
        runId: cancellationRunId,
        origin: options.origin ?? state.origin,
        signal: options.signal,
        approve: options.approve ?? opts.approve,
        onAssistantDelta: options.onAssistantDelta,
        onAssistantReplace: options.onAssistantReplace,
        onToolEvent: options.onToolEvent,
        permissionPolicyId: options.permissionPolicyId ?? 'research',
        reasoning: options.reasoning ?? state.reasoning,
        profile: options.profile ?? normalizeAgentProfileId(state.behaviorModeId),
        workspaceContext: options.workspaceContext ?? state.workspaceContext,
        workspaceAccessApproved: options.workspaceAccessApproved,
        requireApprovalForAllTools: options.requireApprovalForAllTools,
        toolFilter: options.toolFilter,
        requestKey: options.requestKey,
      }, {
        checkpoint,
        inbound: continuationInbound,
        historyExcludeMessageIds: [
          state.inboundMessageId,
          ...(existingAnswer ? [existingAnswer.id] : []),
        ],
        persistInbound: !existingAnswer,
        resumeStage: 'reply',
        restoreState: false,
      }, buildConversationContinuationEvidence({
        checkpoint,
        turnId: conversationTurnMessageId(checkpoint.sessionId, options.requestKey),
        inputDigest: resolvedResumeTurnInputDigest(checkpoint, options, answerText!),
        resolution: 'abandoned',
        requestId: clarificationRequest?.id,
        answerMessageId,
        resumeRunId: cancellationRunId,
        decision: dispositionDecision,
        resumeStage: 'reply',
        resumeRule: 'cancel->reply',
        resourceStatus: 'skipped_for_disposition',
        currentPermission: options.permissionPolicyId ?? 'research',
        answerMessageAlreadyPersisted: Boolean(existingAnswer),
      }))
    }

    if (dispositionDecision?.kind === 'new_task') {
      const outcome = await checkpointController.defer(
        checkpoint.id,
        dispositionDecision.reason ?? 'user started a separate new task',
        claimIdentity,
      )
      if (outcome.kind === 'conflict') throw new Error(`run checkpoint defer conflict: ${outcome.message}`)
      const newTaskRunId = options.runId?.trim() || randomUUID()
      return executeRun({
        sessionId: checkpoint.sessionId,
        text: answerText!,
        cwd: options.cwd,
        runId: newTaskRunId,
        origin: options.origin ?? 'app',
        signal: options.signal,
        approve: options.approve ?? opts.approve,
        onAssistantDelta: options.onAssistantDelta,
        onAssistantReplace: options.onAssistantReplace,
        onToolEvent: options.onToolEvent,
        permissionPolicyId: options.permissionPolicyId ?? 'research',
        reasoning: options.reasoning,
        profile: options.profile,
        workspaceContext: options.workspaceContext,
        workspaceAccessApproved: options.workspaceAccessApproved,
        requireApprovalForAllTools: options.requireApprovalForAllTools,
        toolFilter: options.toolFilter,
        attachments: options.attachments,
        additionalTools: options.additionalTools,
        requestKey: options.requestKey,
      }, undefined, buildConversationContinuationEvidence({
        checkpoint,
        turnId: conversationTurnMessageId(checkpoint.sessionId, options.requestKey),
        inputDigest: resolvedResumeTurnInputDigest(checkpoint, options, answerText!),
        resolution: 'deferred',
        requestId: clarificationRequest?.id,
        answerMessageId,
        resumeRunId: newTaskRunId,
        decision: dispositionDecision,
        resumeStage: 'classify',
        resumeRule: 'new_task->fresh_classify',
        resourceStatus: 'skipped_for_disposition',
        currentPermission: options.permissionPolicyId ?? 'research',
        answerMessageAlreadyPersisted: false,
      }))
    }

    let resources: RestoredCheckpointResources = {
      attachments: options.attachments,
      additionalTools: options.additionalTools,
    }
    const recoveryState = recoveryCheckpoint.resumeState ?? state
    if ((recoveryState.attachmentCount > 0 || (recoveryState.toolRecipes?.length ?? 0) > 0)) {
      if (!options.restoreCheckpointResources) {
        throw new ContinuationControlError(
          'run checkpoint resources require a trusted host restore provider',
          continuationFailureEvidence({
            input: resumeTurnInput(checkpoint, options, answerText ?? messageText(inbound)),
            resolution: 'blocked',
            checkpoint,
            requestId: clarificationRequest?.id,
            answerMessageId,
            code: 'resource_restore_failed',
            detail: 'trusted host resource restore provider is unavailable',
            recoverable: true,
            resourceStatus: 'failed',
          }),
        )
      }
      try {
        resources = await options.restoreCheckpointResources(recoveryCheckpoint, resources)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new ContinuationControlError(
          `run checkpoint resource restoration failed: ${detail}`,
          continuationFailureEvidence({
            input: resumeTurnInput(checkpoint, options, answerText ?? messageText(inbound)),
            resolution: 'blocked',
            checkpoint,
            requestId: clarificationRequest?.id,
            answerMessageId,
            code: 'resource_restore_failed',
            detail,
            recoverable: true,
            resourceStatus: 'failed',
          }),
        )
      }
    }
    const availableNames = new Set([
      ...infra.registry.list().map((item) => item.tool.name),
      ...(resources.additionalTools ?? []).map((tool) => tool.name),
    ])
    const missingTools = recoveryState.availableToolNames.filter((name) => !availableNames.has(name))
    if (missingTools.length > 0) {
      const detail = `required tools are unavailable: ${missingTools.join(', ')}`
      throw new ContinuationControlError(
        `run checkpoint ${detail}`,
        continuationFailureEvidence({
          input: resumeTurnInput(checkpoint, options, answerText ?? messageText(inbound)),
          resolution: 'blocked',
          checkpoint,
          requestId: clarificationRequest?.id,
          answerMessageId,
          code: 'required_tool_unavailable',
          detail,
          recoverable: true,
        }),
      )
    }
    const resumeRunId = options.runId?.trim() || randomUUID()
    const resumeStage = dispositionDecision?.kind === 'revise_goal'
      ? 'decide'
      : recoveryCheckpoint === checkpoint
        ? resolveSemanticResumeStage(checkpoint, clarificationRequest?.sourceStage)
        : resolveSemanticResumeStage(recoveryCheckpoint)
    const claim = await checkpointController.claimResume(
      checkpoint.id,
      options.reason ?? 'user requested checkpoint continuation',
      resumeRunId,
      model,
      claimIdentity,
      {
        allowDeferred: priorDisposition?.status === 'deferred'
          && options.continuationDirective === 'answer',
      },
    )
    if (claim.kind === 'blocked') {
      const detail = claim.inspection.reasons.join('; ')
      throw new ContinuationControlError(
        `run checkpoint cannot be resumed: ${detail}`,
        continuationFailureEvidence({
          input: resumeTurnInput(checkpoint, options, answerText ?? messageText(inbound)),
          resolution: 'blocked',
          checkpoint,
          requestId: clarificationRequest?.id,
          answerMessageId,
          code: 'checkpoint_not_resumable',
          detail,
          recoverable: true,
        }),
      )
    }
    if (claim.kind === 'joined') {
      return waitForConversationTurnResult(
        claim.disposition.resumeRunId ?? resumeRunId,
        checkpoint.sessionId,
        isClarification ? answerText! : messageText(inbound),
        options.signal,
      )
    }
    if (claim.kind === 'conflict') {
      throw new ContinuationControlError(
        `run checkpoint resume conflict: ${claim.message}`,
        continuationFailureEvidence({
          input: resumeTurnInput(checkpoint, options, answerText ?? messageText(inbound)),
          resolution: 'conflict',
          checkpoint,
          requestId: clarificationRequest?.id,
          answerMessageId,
          code: 'claim_conflict',
          detail: claim.message,
          recoverable: true,
        }),
      )
    }

    continuationInbound.runId = resumeRunId
    try {
      const result = await executeRun({
        sessionId: checkpoint.sessionId,
        text: isClarification ? answerText! : messageText(inbound),
        cwd: options.cwd ?? recoveryState.cwd,
        runId: resumeRunId,
        origin: options.origin ?? recoveryState.origin,
        signal: options.signal,
        approve: options.approve ?? opts.approve,
        onAssistantDelta: options.onAssistantDelta,
        onAssistantReplace: options.onAssistantReplace,
        onToolEvent: options.onToolEvent,
        permissionPolicyId: options.permissionPolicyId ?? 'research',
        reasoning: options.reasoning ?? recoveryState.reasoning,
        profile: options.profile ?? normalizeAgentProfileId(recoveryState.behaviorModeId),
        workspaceContext: options.workspaceContext ?? recoveryState.workspaceContext,
        workspaceAccessApproved: options.workspaceAccessApproved,
        requireApprovalForAllTools: options.requireApprovalForAllTools,
        toolFilter: options.toolFilter,
        attachments: resources.attachments,
        additionalTools: resources.additionalTools,
      }, {
        checkpoint: recoveryCheckpoint,
        inbound: continuationInbound,
        historyExcludeMessageIds: [
          state.inboundMessageId,
          ...(existingAnswer ? [existingAnswer.id] : []),
        ],
        persistInbound: isClarification && !existingAnswer,
        resumeStage,
        ...(dispositionDecision?.kind === 'revise_goal'
          ? { revisionFeedback: `The user revised the same task goal or acceptance criteria:\n${answerText}` }
          : {}),
      }, buildConversationContinuationEvidence({
        checkpoint,
        turnId: conversationTurnMessageId(checkpoint.sessionId, options.requestKey),
        inputDigest: resolvedResumeTurnInputDigest(
          checkpoint,
          options,
          isClarification ? answerText! : messageText(inbound),
        ),
        resolution: 'bound',
        requestId: clarificationRequest?.id,
        answerMessageId,
        resumeRunId,
        decision: dispositionDecision,
        resumeStage,
        resumeRule: dispositionDecision?.kind === 'revise_goal'
          ? 'revise_goal->decide'
          : `${clarificationRequest?.sourceStage ?? checkpoint.currentStage}->${resumeStage}`,
        resourceStatus: recoveryState.attachmentCount > 0 || (recoveryState.toolRecipes?.length ?? 0) > 0
          ? 'restored'
          : 'not_required',
        restoredAttachmentCount: resources.attachments?.length ?? 0,
        restoredToolCount: resources.additionalTools?.length ?? 0,
        currentPermission: options.permissionPolicyId ?? 'research',
        answerMessageAlreadyPersisted: Boolean(existingAnswer),
        restoredCheckpoint: recoveryCheckpoint,
      }))
      await checkpointController.completeResume(
        checkpoint.id,
        resumeRunId,
        result.status === 'ok' ? 'ok' : result.status === 'aborted' ? 'aborted' : 'error',
        result.error ?? 'checkpoint continuation completed',
        result.runCheckpointId,
      )
      return result
    } catch (error) {
      const latestCheckpoint = await infra.runCheckpointStore.latestForRun(resumeRunId).catch(() => null)
      await checkpointController.interruptResume(
        checkpoint.id,
        resumeRunId,
        error instanceof Error ? error.message : String(error),
        latestCheckpoint?.id === checkpoint.id ? undefined : latestCheckpoint?.id,
      ).catch(() => undefined)
      throw error
    }
  }

  async function run(input: RunInput): Promise<RunnerResult> {
    if (!input.sessionId || !input.requestKey?.trim()) {
      return executeWithContinuationAudit(
        input,
        input.runId ?? randomUUID(),
        () => runAuthoritative(input),
      )
    }
    const coordinatedInput = { ...input, sessionId: input.sessionId, requestKey: input.requestKey }
    return coordinateConversationTurn(
      coordinatedInput,
      undefined,
      (coordinated, inputDigest) => runAuthoritative(coordinated, inputDigest),
    )
  }

  async function resumeCheckpoint(
    checkpointId: string,
    options: ResumeCheckpointOptions = {},
  ): Promise<RunnerResult> {
    if (!infra.runCheckpointStore) return resumeCheckpointAuthoritative(checkpointId, options)
    const checkpoint = await infra.runCheckpointStore.read(checkpointId)
    if (!checkpoint) throw new Error(`run checkpoint not found: ${checkpointId}`)
    const turnInput = resumeTurnInput(checkpoint, options, options.text?.trim() ?? '')
    if (!options.requestKey?.trim()) {
      return executeWithContinuationAudit(
        turnInput,
        options.runId ?? randomUUID(),
        () => resumeCheckpointAuthoritative(checkpointId, options),
      )
    }
    const coordinatedInput = { ...turnInput, requestKey: options.requestKey }
    return coordinateConversationTurn(coordinatedInput, checkpointId, (coordinated, inputDigest) => (
      resumeCheckpointAuthoritative(checkpointId, {
        ...options,
        runId: coordinated.runId,
        signal: coordinated.signal,
        onAssistantDelta: coordinated.onAssistantDelta,
        onAssistantReplace: coordinated.onAssistantReplace,
        onToolEvent: coordinated.onToolEvent,
        authoritativeTurnInputDigest: inputDigest,
      })
    ))
  }

  async function coordinateConversationTurn(
    input: RunInput & { sessionId: SessionId; requestKey: string },
    checkpointId: string | undefined,
    execute: (
      input: RunInput & { sessionId: SessionId; requestKey: string; runId: string },
      inputDigest: string,
    ) => Promise<RunnerResult>,
  ): Promise<RunnerResult> {
    const turnId = conversationTurnMessageId(input.sessionId, input.requestKey)!
    const stableRunId = conversationTurnRunId(input.sessionId, input.requestKey)!
    const inputDigest = conversationTurnInputDigest({
      sessionId: input.sessionId,
      requestKey: input.requestKey,
      text: input.text,
      checkpointId,
      cwd: input.cwd,
      origin: input.origin,
      permissionPolicyId: input.permissionPolicyId,
      reasoning: input.reasoning,
      profile: input.profile,
      attachments: input.attachments,
    })
    if (input.runId?.trim() && input.runId.trim() !== stableRunId) {
      throw new ContinuationControlError(
        'conversation turn run id conflicts with its stable request identity',
        continuationFailureEvidence({
          input,
          resolution: 'conflict',
          code: 'turn_identity_conflict',
          detail: 'caller-supplied run id does not match sessionId + requestKey',
          recoverable: false,
          inputDigest,
        }),
      )
    }

    const existing = conversationTurns.get(turnId)
    if (existing) {
      if (existing.inputDigest !== inputDigest) {
        throw new ContinuationControlError(
          'conversation request key conflicts with different turn content or runtime inputs',
          continuationFailureEvidence({
            input: { ...input, runId: stableRunId },
            resolution: 'conflict',
            code: 'turn_identity_conflict',
            detail: 'the same requestKey was reused with a different turn fingerprint',
            recoverable: false,
            inputDigest,
          }),
        )
      }
      return observeConversationTurn(existing, input)
    }

    const entry: CoordinatedConversationTurn = {
      inputDigest,
      promise: Promise.resolve(undefined as never),
      settled: false,
      callbacks: { delta: new Set(), replace: new Set(), tool: new Set() },
    }
    const coordinated: RunInput & { sessionId: SessionId; requestKey: string; runId: string } = {
      ...input,
      runId: stableRunId,
      onAssistantDelta: (delta) => publishConversationTurn(entry.callbacks.delta, delta),
      onAssistantReplace: (replacement) => publishConversationTurn(entry.callbacks.replace, replacement),
      onToolEvent: (event) => publishConversationTurn(entry.callbacks.tool, event),
    }
    entry.promise = (async () => {
      const persisted = await infra.executionLogStore.read(stableRunId)
      if (persisted) {
        const replayed = await prepareInternalAuthoritativeResult(
          replayConversationTurn(persisted, input.sessionId, input.text, inputDigest),
        );
        await promoteExecutionLogSettlement(infra.executionLogStore, replayed, opts.log);
        return replayed;
      }
      const recovered = await recoverCompletedConversationTurn(
        coordinated,
        stableRunId,
        inputDigest,
        checkpointId,
      )
      if (recovered) return recovered
      return executeWithContinuationAudit(
        coordinated,
        stableRunId,
        () => execute(coordinated, inputDigest),
        inputDigest,
      )
    })()
    conversationTurns.set(turnId, entry)
    void entry.promise.then(
      () => { entry.settled = true; pruneConversationTurns(conversationTurns) },
      () => { entry.settled = true; pruneConversationTurns(conversationTurns) },
    )
    return observeConversationTurn(entry, input)
  }

  async function recoverCompletedConversationTurn(
    input: RunInput & { sessionId: SessionId; requestKey: string },
    stableRunId: string,
    inputDigest: string,
    explicitCheckpointId?: string,
  ): Promise<RunnerResult | null> {
    const messages = await infra.sessionManager.read(input.sessionId)
    const turnId = conversationTurnMessageId(input.sessionId, input.requestKey)!
    const stableInbound = messages.find((message) => message.id === turnId)
    if (stableInbound && (stableInbound.role !== 'user' || messageText(stableInbound) !== input.text.trim())) {
      throw new ContinuationControlError(
        'conversation request key conflicts with a different persisted session message',
        continuationFailureEvidence({
          input: { ...input, runId: stableRunId },
          resolution: 'conflict',
          code: 'turn_identity_conflict',
          detail: 'persisted stable inbound message does not match the retried turn',
          recoverable: false,
          inputDigest,
        }),
      )
    }

    // A durable Runtime terminal status is authoritative even when the
    // execution-log write failed. A retried request must not fall through to
    // appendIfAbsent (which would report an internal "already accepted"
    // error) or re-enter the model/tool loop. Return a bounded Runtime result
    // reconstructed from the durable projection instead.
    let durableProjection: import('@littlesheep/types').DurableRunProjection | undefined
    try {
      durableProjection = reduceDurableRunProjection(await infra.durableEventStore.read(
        String(input.sessionId),
        stableRunId,
      ))
    } catch {
      durableProjection = undefined
    }
    if (durableProjection && durableProjection.eventCount > 0) {
      // If the process died after writing a proposal, make one conservative
      // recovery pass before deciding what a retry may observe. Recovery only
      // appends bounded facts; it never invokes a model or tool.
      if (!isDurableProjectionTerminalForRetry(durableProjection)) {
        await recoverDurableProjectionForRetry(input.sessionId, stableRunId)
          .catch(() => undefined)
        try {
          durableProjection = reduceDurableRunProjection(await infra.durableEventStore.read(
            String(input.sessionId),
            stableRunId,
          ))
        } catch {
          durableProjection = undefined
        }
      }
      if (durableProjection && (
        durableProjection.finalReply.state === 'runtime_status'
        || (isDurableProjectionTerminalForRetry(durableProjection)
          && durableProjection.finalReply.state !== 'settled')
      )) {
        return prepareInternalAuthoritativeResult({
          runId: stableRunId,
          sessionId: input.sessionId,
          status: 'error',
          reply: '',
          messages: [],
          trace: [],
          durationMs: 0,
        })
      }
    }
    const runMessages = messages.filter((message) => message.runId === stableRunId)
    const finalReply = [...runMessages].reverse().find((message) => (
      message.role === 'assistant'
      && message.stage === 'finalize'
      && Boolean(messageText(message).trim())
    ))
    if (!finalReply) return null

    let authoritativeSettlement: FinalReplySettlement | undefined;
    let authoritativeReply = messageText(finalReply).trim();
    const durableFinalReply = durableProjection?.finalReply;
    if (durableFinalReply?.state === 'settled') {
      if (!durableFinalReply.settlementId
        || !durableFinalReply.reply
        || !durableFinalReply.replyFingerprint
        || !durableFinalReply.modelRequestId) {
        return null;
      }
      authoritativeSettlement = {
        version: 1,
        settlementId: durableFinalReply.settlementId,
        reply: durableFinalReply.reply,
        replyFingerprint: durableFinalReply.replyFingerprint,
        modelRequestId: durableFinalReply.modelRequestId,
        status: 'settled',
      };
      authoritativeReply = durableFinalReply.reply;
    }

    // A new-path transcript message is only a proposal until both the session
    // settlement registry and durable event projection confirm the same
    // identity. Legacy messages without this field retain their old replay
    // behavior for backward compatibility.
    if (finalReply.finalReplySettlement) {
      const settlement = finalReply.finalReplySettlement;
      const registryStatus = await infra.sessionManager.assistantReplySettlementStatus?.(
        input.sessionId,
        settlement.settlementId,
      );
      if (registryStatus !== 'settled') return null;
      let projection: import('@littlesheep/types').DurableRunProjection;
      try {
        projection = reduceDurableRunProjection(await infra.durableEventStore.read(
          String(input.sessionId),
          stableRunId,
        ));
      } catch {
        return null;
      }
      if (projection.finalReply.state !== 'settled'
        || projection.finalReply.settlementId !== settlement.settlementId) return null;
      if (!authoritativeSettlement
        && projection.finalReply.reply
        && projection.finalReply.replyFingerprint
        && projection.finalReply.modelRequestId) {
        authoritativeSettlement = {
          version: 1,
          settlementId: settlement.settlementId,
          reply: projection.finalReply.reply,
          replyFingerprint: projection.finalReply.replyFingerprint,
          modelRequestId: projection.finalReply.modelRequestId,
          status: 'settled',
        };
        authoritativeReply = projection.finalReply.reply;
      }
    }

    if (authoritativeSettlement) {
      const reservation: FinalReplyReservation = {
        version: authoritativeSettlement.version,
        settlementId: authoritativeSettlement.settlementId,
        reply: authoritativeSettlement.reply,
        replyFingerprint: authoritativeSettlement.replyFingerprint,
        modelRequestId: authoritativeSettlement.modelRequestId,
      };
      await infra.sessionManager.settleAssistantReplySettlement(input.sessionId, reservation)
        .catch((error) => {
          // The durable event and registry remain authoritative; a transcript
          // rewrite can be retried without re-running the conversation turn.
          opts.log?.('error', 'runner: failed to repair settled transcript proposal: ' + (error as Error).message);
        });
    }

    let sourceInspection = explicitCheckpointId
      ? await checkpointController?.inspect(explicitCheckpointId, model)
      : null
    if (!sourceInspection && checkpointController) {
      const resolution = await checkpointController.resolveResumeClaim(stableRunId, input.requestKey)
      if (resolution.kind === 'conflict') {
        throw new ContinuationControlError(
          'conversation completion receipt matches multiple durable resume claims',
          continuationFailureEvidence({
            input: { ...input, runId: stableRunId },
            resolution: 'conflict',
            candidateCheckpointIds: resolution.checkpointIds,
            code: 'turn_identity_conflict',
            detail: 'multiple checkpoint dispositions claim the same resume run and request key',
            recoverable: false,
            inputDigest,
          }),
        )
      }
      sourceInspection = resolution.kind === 'found'
        ? await checkpointController.inspect(resolution.disposition.checkpointId, model)
        : null
    }
    const sourceCheckpoint = sourceInspection?.checkpoint
    const disposition = sourceInspection?.disposition
    if (!stableInbound && disposition?.answerMessageId !== turnId) return null

    const nextCheckpoint = disposition?.nextCheckpointId && infra.runCheckpointStore
      ? await infra.runCheckpointStore.read(disposition.nextCheckpointId)
      : null
    const recoveredState = nextCheckpoint ?? sourceCheckpoint
    const reply = authoritativeReply
    const startedAt = stableInbound?.timestamp ?? runMessages[0]?.timestamp ?? finalReply.timestamp
    const durationMs = Math.max(0, Date.parse(finalReply.timestamp) - Date.parse(startedAt))
    let resumeStage: StageName | undefined
    if (sourceCheckpoint) {
      try {
        resumeStage = resolveSemanticResumeStage(
          sourceCheckpoint,
          sourceCheckpoint.resumeState?.continuation?.sourceStage,
        )
      } catch {
        resumeStage = undefined
      }
    }
    const continuation: ConversationContinuationEvidence = sourceCheckpoint && disposition
      ? {
          version: 1,
          resolution: 'bound',
          turnId,
          inputDigest,
          checkpointId: sourceCheckpoint.id,
          sourceRunId: String(sourceCheckpoint.runId),
          ...(disposition.requestId ? { requestId: disposition.requestId } : {}),
          ...(disposition.answerMessageId ? { answerMessageId: disposition.answerMessageId } : {}),
          resumeRunId: stableRunId,
          ...(disposition.continuationDisposition
            ? { disposition: disposition.continuationDisposition, dispositionSource: 'runtime_fallback' as const }
            : {}),
          ...(resumeStage ? { resumeStage } : {}),
          resumeRule: 'durable-session-completion-receipt->replay',
          ...(sourceCheckpoint.resumeState ? {
            resources: {
              status: sourceCheckpoint.resumeState.attachmentCount > 0
                || (sourceCheckpoint.resumeState.toolRecipes?.length ?? 0) > 0
                ? 'restored'
                : 'not_required',
              attachmentCount: sourceCheckpoint.resumeState.attachmentCount,
              toolRecipeCount: sourceCheckpoint.resumeState.toolRecipes?.length ?? 0,
              restoredToolCount: sourceCheckpoint.resumeState.toolRecipes?.length ?? 0,
            },
            permissions: {
              checkpoint: sourceCheckpoint.resumeState.permissionPolicyId,
              current: input.permissionPolicyId ?? 'research',
            },
          } : {}),
          replayPrevention: {
            completedStepCountPreserved: recoveredState?.taskExecution?.steps
              .filter((step) => step.status === 'done').length ?? 0,
            succeededSideEffectCountPreserved: recoveredState?.sideEffects
              .filter((effect) => effect.status === 'succeeded').length ?? 0,
            uncertainSideEffectCount: recoveredState?.sideEffects
              .filter((effect) => effect.status === 'in_progress' || effect.status === 'unknown').length ?? 0,
            answerMessageAlreadyPersisted: true,
          },
        }
      : { version: 1, resolution: 'none', turnId, inputDigest }
    const result: RunnerResult = {
      runId: stableRunId,
      sessionId: input.sessionId,
      status: 'ok',
      reply,
      replyProvenance: finalReply.replyProvenance,
      finalReplySettlement: authoritativeSettlement ?? finalReply.finalReplySettlement,
      messages: authoritativeSettlement
        ? runMessages.map((message) => (
            message.role === 'assistant' && message.stage === 'finalize'
              ? { ...message, finalReplySettlement: authoritativeSettlement }
              : message
          ))
        : runMessages,
      trace: [],
      durationMs,
      conversationContinuation: continuation,
      taskBook: recoveredState?.taskBook,
      taskExecution: recoveredState?.taskExecution,
      verificationHistory: recoveredState?.resumeState?.verificationHistory,
      sideEffects: recoveredState?.sideEffects,
      runtimeControl: recoveredState?.runtimeControl,
      ...(disposition?.nextCheckpointId ? { runCheckpointId: disposition.nextCheckpointId } : {}),
    }
    const endedAt = finalReply.timestamp
    await infra.executionLogStore.write({
      runId: stableRunId,
      sessionId: String(input.sessionId),
      startedAt,
      endedAt,
      status: 'ok',
      model,
      inboundText: input.text,
      reply,
      replyProvenance: finalReply.replyProvenance,
      finalReplySettlement: authoritativeSettlement ?? finalReply.finalReplySettlement,
      trace: [],
      taskExecution: recoveredState?.taskExecution,
      taskBook: recoveredState?.taskBook,
      verificationHistory: recoveredState?.resumeState?.verificationHistory,
      conversationContinuation: continuation,
      sideEffects: recoveredState?.sideEffects,
      runtimeControl: recoveredState?.runtimeControl,
      runCheckpointId: disposition?.nextCheckpointId,
      messages: runMessages,
      durationMs,
    }).catch((error) => {
      opts.log?.('error', `runner: failed to materialize recovered completion log: ${(error as Error).message}`)
    })
    if (
      sourceCheckpoint
      && disposition?.resumeRunId === stableRunId
      && (disposition.status === 'resuming' || disposition.status === 'interrupted')
    ) {
      await checkpointController?.reconcileCompletedResume(
        sourceCheckpoint.id,
        stableRunId,
        'ok',
        'durable session completion receipt recovered a missing execution log',
        disposition.nextCheckpointId,
      ).catch((error) => {
        opts.log?.('error', `runner: failed to reconcile recovered completion: ${(error as Error).message}`)
      })
    }
    return result
  }

  async function recoverDurableProjectionForRetry(
    sessionId: SessionId,
    runId: string,
  ): Promise<void> {
    await durableKernel.recoverRun(String(sessionId), runId, {
      finalReplyPersisted: async (reservation) => (
        await infra.sessionManager.assistantReplySettlementStatus?.(
          sessionId,
          reservation.settlementId,
        )
      ) === 'settled',
      finalReplyRegistrySettled: async (reservation) => {
        try {
          await infra.sessionManager.settleAssistantReplySettlement?.(sessionId, reservation)
          return (await infra.sessionManager.assistantReplySettlementStatus?.(
            sessionId,
            reservation.settlementId,
          )) === 'settled'
        } catch {
          return false
        }
      },
    })
  }

  async function executeWithContinuationAudit(
    input: RunInput & { sessionId?: SessionId },
    runId: string,
    execute: () => Promise<RunnerResult>,
    inputDigest?: string,
  ): Promise<RunnerResult> {
    try {
      return await execute()
    } catch (error) {
      if (error instanceof ContinuationControlError && input.sessionId) {
        await persistContinuationFailure(runId, input.sessionId, input.text, error, inputDigest)
      }
      throw error
    }
  }

  async function persistContinuationFailure(
    runId: string,
    sessionId: SessionId,
    text: string,
    error: ContinuationControlError,
    inputDigest?: string,
  ): Promise<void> {
    if (await infra.executionLogStore.read(runId)) return
    const now = new Date().toISOString()
    const evidence: ConversationContinuationEvidence = {
      ...error.evidence,
      ...(inputDigest ? { inputDigest } : {}),
    }
    await infra.executionLogStore.write({
      runId,
      sessionId: String(sessionId),
      startedAt: now,
      endedAt: now,
      status: 'error',
      model,
      inboundText: inputDigest ? '[redacted continuation answer]' : text.slice(0, 16 * 1024),
      reply: '',
      error: error.message.slice(0, 4_096),
      trace: [],
      conversationContinuation: evidence,
      messages: [],
      durationMs: 0,
    }).catch((auditError) => {
      opts.log?.('error', `runner: failed to persist continuation decision audit: ${(auditError as Error).message}`)
    })
  }

  async function waitForConversationTurnResult(
    runId: string,
    sessionId: SessionId,
    text: string,
    signal?: AbortSignal,
  ): Promise<RunnerResult> {
    const deadline = Date.now() + (RUN_TIMEOUT_MS > 0 ? RUN_TIMEOUT_MS + 30_000 : 10 * 60_000)
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error('conversation turn observation aborted')
      const log = await infra.executionLogStore.read(runId)
      if (log) {
        const replayed = await prepareInternalAuthoritativeResult(replayConversationTurn(log, sessionId, text));
        await promoteExecutionLogSettlement(infra.executionLogStore, replayed, opts.log);
        return replayed;
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`conversation turn is still running: ${runId}`)
  }

  function replayConversationTurn(
    log: ExecutionLog,
    sessionId: SessionId,
    text: string,
    inputDigest?: string,
  ): RunnerResult {
    const persistedDigest = log.conversationContinuation?.inputDigest
    const contentMismatch = persistedDigest && inputDigest
      ? persistedDigest !== inputDigest
      : log.inboundText.trim() !== text.trim()
    if (log.sessionId !== String(sessionId) || contentMismatch) {
      throw new ContinuationControlError(
        'conversation request key conflicts with a different persisted turn',
        {
          version: 1,
          resolution: 'conflict',
          ...(log.conversationContinuation?.turnId ? { turnId: log.conversationContinuation.turnId } : {}),
          ...(inputDigest ? { inputDigest } : {}),
          failure: {
            code: 'turn_identity_conflict',
            detail: 'persisted session or inbound text does not match the retried turn',
            recoverable: false,
          },
        },
      )
    }
    if (log.conversationContinuation?.failure) {
      throw new ContinuationControlError(log.error ?? log.conversationContinuation.failure.detail, log.conversationContinuation)
    }
    return {
      runId: log.runId,
      sessionId: asSessionId(log.sessionId),
      status: log.status,
      reply: log.reply,
      replyProvenance: log.replyProvenance,
      finalReplySettlement: log.finalReplySettlement,
      error: log.error,
      messages: [],
      trace: log.trace,
      durationMs: log.durationMs,
      usage: log.usage,
      resolvedRunConfig: log.resolvedRunConfig,
      capabilitySnapshot: log.capabilitySnapshot, capabilityProbe: log.capabilityProbe, capabilityPermissionEvent: log.capabilityPermissionEvent,
      modelRequests: log.modelRequests,
      contextSnapshots: log.contextSnapshots,
      taskExecution: log.taskExecution,
      toolInvocations: log.toolInvocations,
      toolInvocationsTruncated: log.toolInvocationsTruncated,
      sideEffects: log.sideEffects,
      taskBook: log.taskBook,
      verificationHistory: log.verificationHistory,
      runtimeControl: log.runtimeControl,
      runtimeEventQueue: log.runtimeEventQueue,
      memoryIntentDecisions: log.memoryIntentDecisions,
      memoryKnownState: log.memoryKnownState,
      memoryContinuityAssessment: log.memoryContinuityAssessment,
      clarificationRequest: log.clarificationRequest,
      clarificationResponse: log.clarificationResponse,
      conversationContinuation: log.conversationContinuation,
      webEvidence: log.webEvidence,
      memoryAccess: log.memoryAccess,
      versionCheckpoint: log.versionCheckpoint,
      runCheckpointId: log.runCheckpointId,
    }
  }

  async function canJoinActiveContinuation(
    disposition: import('@littlesheep/types').RunCheckpointDisposition | null,
    input: RunInput,
  ): Promise<boolean> {
    if (!input.sessionId || !input.requestKey || !input.runId) return false
    return disposition?.status === 'resuming'
      && disposition.resumeRunId === input.runId
      && disposition.requestKey === input.requestKey
      && disposition.answerMessageId === conversationTurnMessageId(input.sessionId, input.requestKey)
  }

  async function replayAuthoritativeDurableFinalReply(
    sessionId: SessionId,
    runId: string,
  ): Promise<DurableFinalReplyReplay> {
    const durable = await durableKernel.replayFinalReply(String(sessionId), runId);
    if (durable.kind !== 'settled') return durable;
    const registryStatus = await infra.sessionManager.assistantReplySettlementStatus?.(
      sessionId,
      durable.settlementId,
    );
    if (registryStatus === 'settled') return durable;
    return {
      kind: 'unavailable',
      sessionId: String(sessionId),
      runId,
      cursor: durable.cursor,
      status: 'running',
      reason: 'not_settled',
    };
  }

  async function prepareInternalAuthoritativeResult(result: RunnerResult): Promise<RunnerResult> {
    if (opts.durableHarnessMode !== 'next') return result;
    return prepareAuthoritativeRunnerResult({
      durableHarnessMode: 'next',
      replayDurableFinalReply: replayAuthoritativeDurableFinalReply,
    } as AgentRunner, result);
  }

  return {
    run,
    runStream: (input: RunInput, onDelta: (delta: string) => void) =>
      run({ ...input, onAssistantDelta: onDelta }),
    resumeCheckpoint,
    runCheckpoints,
    replay: (runId: string) => infra.executionLogStore.read(runId),
    replayDurableFinalReply: (sessionId: SessionId, runId: string) =>
      replayAuthoritativeDurableFinalReply(sessionId, runId),
    recoverDurableRun: (sessionId: SessionId, runId: string) =>
      durableKernel.recoverRun(String(sessionId), runId, {
        finalReplyPersisted: async (reservation) => (
          await infra.sessionManager.assistantReplySettlementStatus?.(sessionId, reservation.settlementId)
        ) === 'settled',
        finalReplyRegistrySettled: async (reservation) => {
          try {
            await infra.sessionManager.settleAssistantReplySettlement?.(sessionId, reservation);
            return (await infra.sessionManager.assistantReplySettlementStatus?.(
              sessionId,
              reservation.settlementId,
            )) === 'settled';
          } catch {
            return false;
          }
        },
      }),
    runtimeEvents: activeRuns,
    activeRuns,
    shutdown: async () => {
      conversationTurns.clear();
      activeRuns.dispose();
      infra.disposeTokenCounter();
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
    durableHarnessMode: opts.durableHarnessMode ?? 'shadow',
    durableHarnessModeForSession: (sessionId: string) => resolveDurableHarnessMode(sessionId),
  };
  }

async function settleRuntimeFailureEvent(
  ctx: RunContext,
  reason: string,
  log?: LogFn,
): Promise<void> {
    try {
      await ctx.appendDurableEvent?.({
        type: 'runtime_status_settled',
        source: 'runtime',
        eventId: `${ctx.runId}:runtime-failure:${reason}`,
        idempotencyKey: `${ctx.runId}:runtime-failure:${reason}`,
        payload: { status: 'failed', reason },
      });
    } catch (error) {
      log?.('error', `runner: failed to persist Runtime failure status: ${(error as Error).message}`);
    }
}

function runtimeFailureResult(result: RunnerResult, reason: string): RunnerResult {
    const runtimeStatus = {
      version: 1 as const,
      status: 'failed' as const,
      reason,
    };
    return {
      ...result,
      status: 'error',
      reply: '',
      replyProvenance: undefined,
      finalReplySettlement: undefined,
      runtimeStatus,
      error: `Runtime failed before publishing a final reply. Reason: ${reason}`,
      messages: result.messages.filter((message) => !(message.role === 'assistant' && message.stage === 'finalize')),
      webEvidence: undefined,
    };
}

function settledReplyResult(result: RunnerResult, ctx: RunContext): RunnerResult {
    const settlement = ctx.finalReplySettlement;
    if (!settlement || settlement.status !== 'settled') {
      throw new Error('next Harness settled without a final reply projection');
    }
    return {
      ...result,
      status: 'ok',
      reply: settlement.reply,
      finalReplySettlement: settlement,
      runtimeStatus: undefined,
      error: undefined,
      messages: result.messages.map((message) => (
        message.role === 'assistant' && message.stage === 'finalize'
          ? { ...message, finalReplySettlement: settlement }
          : message
      )),
    };
}

/**
 * Repair the secondary projections after the authoritative final-reply
 * settlement. Neither repair is allowed to downgrade an already settled
 * user-visible reply; startup recovery can retry either projection later.
 */
async function settleFinalReplyArtifacts(
  ctx: RunContext,
  infra: Infrastructure,
  log?: LogFn,
): Promise<void> {
  const settlement = ctx.finalReplySettlement;
  if (!settlement || settlement.status !== 'settled') return;

  try {
    await promoteExecutionLogSettlement(infra.executionLogStore, { runId: ctx.runId, finalReplySettlement: settlement }, log);
  } catch (error) {
    log?.('error', 'runner: settled execution-log repair guard failed: ' + (error as Error).message);
  }

  try {
    await infra.memoryService.captureConversationSources(collectConversationSourceRecords(ctx));
  } catch (error) {
    log?.('warn', 'runner: settled assistant conversation source capture degraded: ' + (error as Error).message);
  }
}

async function promoteExecutionLogSettlement(
  executionLogStore: Infrastructure['executionLogStore'],
  result: Pick<RunnerResult, 'runId' | 'finalReplySettlement'>,
  log?: LogFn,
): Promise<void> {
  const settlement = result.finalReplySettlement;
  if (!settlement || settlement.status !== 'settled') return;
  try {
    await executionLogStore.settleFinalReply(result.runId, settlement);
  } catch (error) {
    log?.('error', 'runner: failed to promote settled final reply in execution log: ' + (error as Error).message);
  }
}

function isDurableProjectionTerminalForRetry(
  projection: import('@littlesheep/types').DurableRunProjection,
): boolean {
  return projection.status === 'completed'
    || projection.status === 'failed'
    || projection.status === 'interrupted'
    || projection.finalReply.state === 'runtime_status'
}

  async function observeConversationTurn(
  entry: CoordinatedConversationTurn,
  callbacks: ConversationTurnCallbacks,
): Promise<RunnerResult> {
  if (callbacks.onAssistantDelta) entry.callbacks.delta.add(callbacks.onAssistantDelta)
  if (callbacks.onAssistantReplace) entry.callbacks.replace.add(callbacks.onAssistantReplace)
  if (callbacks.onToolEvent) entry.callbacks.tool.add(callbacks.onToolEvent)
  try {
    return await entry.promise
  } finally {
    if (callbacks.onAssistantDelta) entry.callbacks.delta.delete(callbacks.onAssistantDelta)
    if (callbacks.onAssistantReplace) entry.callbacks.replace.delete(callbacks.onAssistantReplace)
    if (callbacks.onToolEvent) entry.callbacks.tool.delete(callbacks.onToolEvent)
  }
}

function publishConversationTurn<T>(subscribers: Set<(value: T) => void>, value: T): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(value)
    } catch {
      // An observer cannot interrupt the Main-owned run or other observers.
    }
  }
}

function pruneConversationTurns(turns: Map<string, CoordinatedConversationTurn>): void {
  if (turns.size <= MAX_RETAINED_CONVERSATION_TURNS) return
  for (const [turnId, entry] of turns) {
    if (!entry.settled) continue
    turns.delete(turnId)
    if (turns.size <= MAX_RETAINED_CONVERSATION_TURNS) break
  }
}

function resumeTurnInput(
  checkpoint: RunCheckpoint,
  options: ResumeCheckpointOptions,
  text: string,
): RunInput & { sessionId: SessionId } {
  return {
    sessionId: checkpoint.sessionId,
    text,
    runId: options.runId,
    signal: options.signal,
    approve: options.approve,
    origin: options.origin,
    cwd: options.cwd ?? checkpoint.resumeState?.cwd,
    onAssistantDelta: options.onAssistantDelta,
    onAssistantReplace: options.onAssistantReplace,
    toolFilter: options.toolFilter,
    requireApprovalForAllTools: options.requireApprovalForAllTools,
    permissionPolicyId: options.permissionPolicyId,
    workspaceAccessApproved: options.workspaceAccessApproved,
    reasoning: options.reasoning,
    profile: options.profile,
    onToolEvent: options.onToolEvent,
    attachments: options.attachments,
    additionalTools: options.additionalTools,
    workspaceContext: options.workspaceContext,
    requestKey: options.requestKey,
    restoreCheckpointResources: options.restoreCheckpointResources,
    continuationDirective: options.continuationDirective,
  }
}

function resolvedResumeTurnInputDigest(
  checkpoint: RunCheckpoint,
  options: AuthoritativeResumeCheckpointOptions,
  text: string,
): string | undefined {
  if (options.authoritativeTurnInputDigest) return options.authoritativeTurnInputDigest
  if (!options.requestKey?.trim()) return undefined
  const input = resumeTurnInput(checkpoint, options, text)
  return conversationTurnInputDigest({
    sessionId: checkpoint.sessionId,
    requestKey: options.requestKey,
    text,
    checkpointId: checkpoint.id,
    cwd: input.cwd,
    origin: input.origin,
    permissionPolicyId: input.permissionPolicyId,
    reasoning: input.reasoning,
    profile: input.profile,
    attachments: input.attachments,
  })
}

function continuationFailureEvidence(input: {
  input: RunInput
  resolution: 'blocked' | 'conflict'
  checkpoint?: RunCheckpoint
  candidateCheckpointIds?: string[]
  requestId?: string
  answerMessageId?: string
  code: NonNullable<ConversationContinuationEvidence['failure']>['code']
  detail: string
  recoverable: boolean
  resourceStatus?: NonNullable<ConversationContinuationEvidence['resources']>['status']
  inputDigest?: string
}): ConversationContinuationEvidence {
  const checkpoint = input.checkpoint
  const state = checkpoint?.resumeState
  const taskSteps = checkpoint?.taskExecution?.steps ?? []
  const sideEffects = checkpoint?.sideEffects ?? []
  const turnId = input.input.sessionId
    ? conversationTurnMessageId(input.input.sessionId, input.input.requestKey)
    : undefined
  return {
    version: 1,
    resolution: input.resolution,
    ...(turnId ? { turnId } : {}),
    ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
    ...(checkpoint ? { checkpointId: checkpoint.id, sourceRunId: String(checkpoint.runId) } : {}),
    ...(input.candidateCheckpointIds ? { candidateCheckpointIds: [...input.candidateCheckpointIds] } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.answerMessageId ? { answerMessageId: input.answerMessageId } : {}),
    ...(input.input.runId ? { resumeRunId: input.input.runId } : {}),
    ...(state ? {
      resources: {
        status: input.resourceStatus ?? 'not_required',
        attachmentCount: state.attachmentCount,
        toolRecipeCount: state.toolRecipes?.length ?? 0,
        restoredToolCount: 0,
      },
      permissions: {
        checkpoint: state.permissionPolicyId,
        current: input.input.permissionPolicyId ?? 'research',
      },
      replayPrevention: {
        completedStepCountPreserved: taskSteps.filter((step) => step.status === 'done').length,
        succeededSideEffectCountPreserved: sideEffects.filter((effect) => effect.status === 'succeeded').length,
        uncertainSideEffectCount: sideEffects.filter((effect) => (
          effect.status === 'in_progress' || effect.status === 'unknown'
        )).length,
        answerMessageAlreadyPersisted: false,
      },
    } : {}),
    failure: {
      code: input.code,
      detail: input.detail.slice(0, 4_096),
      recoverable: input.recoverable,
    },
  }
}

function shadowContinuationEvidence(
  base: ConversationContinuationEvidence,
  resolution: WaitingUserHeadResolution,
  currentPermission: PermissionPolicyId,
): ConversationContinuationEvidence {
  if (resolution.kind === 'none') return base
  if (resolution.kind === 'conflict') {
    return {
      ...base,
      resolution: 'conflict',
      candidateCheckpointIds: [...resolution.checkpointIds],
    }
  }
  const checkpoint = resolution.inspection.checkpoint
  const state = checkpoint.resumeState
  return {
    ...base,
    resolution: resolution.kind === 'eligible' ? 'eligible' : 'blocked',
    checkpointId: checkpoint.id,
    sourceRunId: String(checkpoint.runId),
    ...(state?.continuation?.requestId ? { requestId: state.continuation.requestId } : {}),
    ...(state ? {
      resources: {
        status: resolution.kind === 'blocked' && state.attachmentCount > 0 ? 'failed' : 'not_required',
        attachmentCount: state.attachmentCount,
        toolRecipeCount: state.toolRecipes?.length ?? 0,
        restoredToolCount: 0,
      },
      permissions: {
        checkpoint: state.permissionPolicyId,
        current: currentPermission,
      },
    } : {}),
  }
}

function buildConversationContinuationEvidence(input: {
  checkpoint: RunCheckpoint
  restoredCheckpoint?: RunCheckpoint
  turnId?: string
  inputDigest?: string
  resolution: Extract<ConversationContinuationEvidence['resolution'], 'bound' | 'deferred' | 'abandoned'>
  requestId?: string
  answerMessageId?: string
  resumeRunId: string
  decision?: ContinuationDispositionDecision
  resumeStage: StageName
  resumeRule: string
  resourceStatus: NonNullable<ConversationContinuationEvidence['resources']>['status']
  restoredAttachmentCount?: number
  restoredToolCount?: number
  currentPermission: PermissionPolicyId
  answerMessageAlreadyPersisted: boolean
}): ConversationContinuationEvidence {
  const restored = input.restoredCheckpoint ?? input.checkpoint
  const taskSteps = restored.taskExecution?.steps ?? []
  const sideEffects = restored.sideEffects
  return {
    version: 1,
    resolution: input.resolution,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
    checkpointId: input.checkpoint.id,
    sourceRunId: String(input.checkpoint.runId),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.answerMessageId ? { answerMessageId: input.answerMessageId } : {}),
    resumeRunId: input.resumeRunId,
    ...(input.decision && input.decision.kind !== 'ambiguous'
      ? { disposition: input.decision.kind, dispositionSource: input.decision.source }
      : {}),
    resumeStage: input.resumeStage,
    resumeRule: input.resumeRule.slice(0, 256),
    resources: {
      status: input.resourceStatus,
      attachmentCount: input.restoredAttachmentCount ?? 0,
      toolRecipeCount: restored.resumeState?.toolRecipes?.length ?? 0,
      restoredToolCount: input.restoredToolCount ?? 0,
    },
    permissions: {
      checkpoint: input.checkpoint.resumeState?.permissionPolicyId ?? 'research',
      current: input.currentPermission,
    },
    replayPrevention: {
      completedStepCountPreserved: taskSteps.filter((step) => step.status === 'done').length,
      succeededSideEffectCountPreserved: sideEffects.filter((effect) => effect.status === 'succeeded').length,
      uncertainSideEffectCount: sideEffects.filter((effect) => (
        effect.status === 'in_progress' || effect.status === 'unknown'
      )).length,
      answerMessageAlreadyPersisted: input.answerMessageAlreadyPersisted,
    },
  }
}

function restoreContinuationContext(
  ctx: RunContext,
  checkpoint: RunCheckpoint,
  resumeStage: StageName,
): void {
  const state = checkpoint.resumeState;
  if (!state) throw new Error('checkpoint has no resumable runtime state');

  ctx.entryStage = resumeStage;
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
  replaceSideEffectEvidence(ctx, 'runner-restore', checkpoint.sideEffects);
  writeModelObservabilityState(ctx, 'runner-restore', {
    modelCallCount: checkpoint.loopBudget.attemptsUsed,
  });
  writeFailureState(ctx, 'runner-restore', {
    recoveryAttempts: state.recoveryAttempts,
    lastError: state.lastError ? structuredClone(state.lastError) : undefined,
  });
  ctx.maxReplanAttempts = state.maxReplanAttempts;
  ctx.verificationHistory = structuredClone(state.verificationHistory);
  // A paused/interrupted control snapshot must not immediately stop the new
  // continuation at its first safe boundary. The original event evidence is
  // retained in the restored queue; the new run starts in a clean state.
  writeRuntimeState(ctx, 'runner-restore', { runtimeControl: undefined });
  ctx.webEvidence = sanitizeWebEvidenceProjection(checkpoint.webEvidence);
  clearReplyState(ctx, 'runner-restore');
}

async function resolveCheckpointClarification(
  sessionManager: SessionManager,
  checkpoint: RunCheckpoint,
): Promise<ClarificationRequest | undefined> {
  const expectedId = checkpoint.resumeState?.continuation?.requestId
  const messages = await sessionManager.read(checkpoint.sessionId)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user') {
      if (expectedId && message.clarificationResponse?.requestId === expectedId) continue
      break
    }
    const request = message.role === 'assistant' ? message.clarificationRequest : undefined
    if (!request) continue
    if (!expectedId || request.id === expectedId) return structuredClone(request)
  }
  return undefined
}
