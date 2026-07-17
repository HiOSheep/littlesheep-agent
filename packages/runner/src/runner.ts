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
} from '@littlesheep/types';
import { asSessionId, textMessage } from '@littlesheep/types';
import { randomUUID } from 'node:crypto';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import type { ChatMessage, ChatRequest, LlmClient } from '@littlesheep/llm';
import { maybeCompact, SessionManager } from '@littlesheep/session';
import {
  buildRunContext,
  buildRunRequestCandidates,
  collectConversationSourceRecords,
  prepareModelRequest,
  recordProviderUsage,
} from '@littlesheep/harness';
import { buildInfrastructure, type RunnerState, type LogFn } from './infra.js';
import type { ExecutionLog } from './execution-log.js';
import type { MemoryAccessLedger } from '@littlesheep/memory-tree';
import { getAgentProfile, type AgentProfileId } from '@littlesheep/prompt';
import { reasoningPromptAddon, resolveRunConfig } from './run-config.js';
import { discoverLittleSheepCoreRoots } from './core-source-protection.js';
import { buildSessionRunSummary } from './session-run-summary.js';
import { independentSuccessfulToolCallIds } from './memory-feedback-evidence.js';
import { recordSessionSummaryActivation } from './session-summary-activation.js';
import type { RunGitCheckpoint } from '@littlesheep/snapshot';
import { completeRunVersionCheckpoint } from './version-checkpoint-lifecycle.js';
import { beginRuntimeResourceObservation, completeRuntimeResourceObservation } from './runtime-resource-observation.js';
/** AgentResult + sessionId (caller-friendly). */
export type RunnerResult = AgentResult & { sessionId: SessionId; memoryAccess?: MemoryAccessLedger };

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
  /** Overall run timeout in ms (default 5 min). When no signal is passed to
   *  run, a timed AbortController is created so a hung tool/LLM can't
   *  block indefinitely. 0 disables the timeout. */
  runTimeoutMs?: number;
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
  /** Tool filter function applied before the run. */
  toolFilter?: (tool: { name: string }) => boolean;
  /** Force every available tool through the stage-level approval gate. */
  requireApprovalForAllTools?: boolean;
  /** Permission policy resolved by the owning adapter. */
  permissionPolicyId?: PermissionPolicyId;
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

export interface AgentRunner {
  run(input: RunInput): Promise<RunnerResult>;
  runStream(input: RunInput, onDelta: (delta: string) => void): Promise<RunnerResult>;
  /** Replay a past run by id (reads execution log). Returns null if not found. */
  replay(runId: string): Promise<ExecutionLog | null>;
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
  const protectedWriteRoots = opts.protectedWriteRoots ?? discoverLittleSheepCoreRoots([
    process.cwd(),
    process.argv[1] ?? '',
  ]);
  const infra = await buildInfrastructure({
    config: opts.config,
    branding: opts.branding,
    model,
    llm: opts.llm,
    skillsDirs: opts.skillsDirs,
    bootstrapDir: opts.bootstrapDir,
    state,
    log: opts.log,
  });

  // Overall run timeout. When run is called without a signal, a timed
  // AbortController is created so a hung tool/LLM can't block indefinitely.
  // 0 disables. Tools and llm.chat both respect ctx.signal (→ toolContext.signal).
  const RUN_TIMEOUT_MS = opts.runTimeoutMs ?? 5 * 60 * 1000;

  async function run(input: RunInput): Promise<RunnerResult> {
    const startedAt = Date.now();
    const runtimeResourceStart = beginRuntimeResourceObservation();
    const runId = input.runId ?? randomUUID();
    const origin = input.origin ?? 'cli';
    const cwd = input.cwd ?? opts.config.agents.defaults.workspace;
    let activeCheckpoint: RunGitCheckpoint | undefined;
    let checkpointCompleted = false;

    // Resolve abort signal: use the caller's if provided, else create one with
    // an overall run timeout so a hung tool/LLM can't block indefinitely.
    let signal = input.signal;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (!signal && RUN_TIMEOUT_MS > 0) {
      const controller = new AbortController();
      timeoutTimer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
      signal = controller.signal;
    }

    try {
      activeCheckpoint = await infra.versioning?.beginRun({ runId, workspaceRoot: cwd });
      // 1. Resolve or create session.
      let sessionId: SessionId;
      if (input.sessionId) {
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

      // 2. Build inbound user message.
      const inbound: Message = textMessage('user', input.text, {
        sessionId,
        runId,
        timestamp: new Date(startedAt).toISOString(),
      });

      // 3. Build RunContext (loads history WITHOUT inbound — no duplicate).
      // Apply caller-provided tool policy before the run.
      let resolvedTools = infra.registry.list().map((r) => r.tool);
      if (input.additionalTools && input.additionalTools.length > 0) {
        const names = new Set(resolvedTools.map((tool) => tool.name));
        for (const tool of input.additionalTools) {
          if (names.has(tool.name)) throw new Error(`Additional tool name conflicts with a registered tool: ${tool.name}`);
          names.add(tool.name);
          resolvedTools.push(tool);
        }
      }
      if (input.toolFilter) {
        resolvedTools = resolvedTools.filter(input.toolFilter);
      }
      if (input.requireApprovalForAllTools) {
        resolvedTools = resolvedTools.map((tool) => ({ ...tool, requiresApproval: true }));
      }

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
      try {
        await infra.memoryService.syncWorkspaceResources(cwd, input.workspaceContext);
        await infra.memoryService.syncWorkspaceDocuments(cwd);
      } catch (error) {
        opts.log?.('warn', `runner: workspace resource registration degraded: ${(error as Error).message}`);
      }
      const ctx: RunContext = await buildRunContext({
        sessionId,
        inbound,
        sessionManager: infra.sessionManager,
        memoryStore: infra.memoryStore,
        tools: resolvedTools,
        config: opts.config,
        branding: opts.branding,
        model,
        runId,
        startedAt: new Date(startedAt).toISOString(),
        previousRun,
        cwd,
        protectedWriteRoots,
        signal,
        approve: input.approve ?? opts.approve,
        log: opts.log,
        versioning: activeCheckpoint,
        onAssistantDelta: input.onAssistantDelta,
        onToolEvent: input.onToolEvent,
        profilePromptAddon: behaviorProfile?.systemPromptAddon,
        reasoningPromptAddon: reasoningPromptAddon(resolvedRunConfig.reasoning),
        attachments: input.attachments,
        resolvedRunConfig,
        bootstrapDir: opts.bootstrapDir,
        memoryResources: infra.memoryService,
      });
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
        ctx.memoryRootIndex = memoryRun.rootIndex;
        usedContinuitySummaryId = memoryRun.continuitySummaryId;
        ctx.initialMemoryContext = memoryRun.initialContext?.content;
        ctx.memoryKnownState = structuredClone(memoryRun.ledger.knownState);
        if (memoryRun.initialContext) {
          ctx.memoryContextWorkingSet = {
            revision: 1,
            activeAtomIds: [...memoryRun.initialContext.atomIds],
            releasedAtomIds: [],
            activeCallByAtom: Object.fromEntries(memoryRun.initialContext.atomIds.map((atomId) => [atomId, 'initial'])),
            callAtomIds: { initial: [...memoryRun.initialContext.atomIds] },
            updatedAt: new Date().toISOString(),
          };
        }
      } catch (err) {
        opts.log?.('warn', `runner: memory tree start degraded: ${(err as Error).message}`);
      }

      // 4. Persist inbound AFTER buildRunContext (so it's not in loaded history)
      //    but BEFORE harness.run (so FINALIZE's append of produced goes after
      //    inbound → correct JSONL order: [..., user, assistant]).
      try {
        await infra.sessionManager.append(sessionId, [inbound]);
      } catch (err) {
        opts.log?.('error', `runner: failed to persist inbound: ${(err as Error).message}`);
      }

      // 5. Run the state machine.
      let stageResult: StageResult;
      let memoryAccess: MemoryAccessLedger | undefined;
      try {
        stageResult = await infra.harness.run(ctx);
      } catch (err) {
        stageResult = {
          stage: 'execute',
          next: 'exit',
          ok: false,
          error: `harness threw: ${(err as Error).message}`,
        };
      }
      try {
        await infra.memoryService.captureConversationSources(collectConversationSourceRecords(ctx));
      } catch (err) {
        opts.log?.('warn', `runner: conversation source capture degraded: ${(err as Error).message}`);
      }
      const latestVerification = ctx.verificationHistory?.at(-1);
      const successfulToolCallIds = independentSuccessfulToolCallIds(ctx);
      const recordedAt = new Date().toISOString();
      try {
        await infra.memoryService.recordRunFeedback({
          runId: ctx.runId,
          status: signal?.aborted ? 'aborted' : stageResult.ok ? 'ok' : 'error',
          references: (ctx.memoryKnownState?.references ?? []).map((reference) => ({
            atomId: reference.atomId,
            decision: reference.decision,
            reason: reference.reason,
          })),
          activeAtomIds: [...(ctx.memoryContextWorkingSet?.activeAtomIds ?? [])],
          releasedAtomIds: [...(ctx.memoryContextWorkingSet?.releasedAtomIds ?? [])],
          usedAtomIds: [...(latestVerification?.usedMemoryAtomIds ?? [])],
          verification: latestVerification ? {
            attempt: latestVerification.attempt,
            verdict: latestVerification.verdict,
            source: latestVerification.source,
            verifiedAt: latestVerification.verifiedAt,
          } : undefined,
          successfulToolCallIds,
          recordedAt,
        });
      } catch (err) {
        opts.log?.('warn', `runner: memory usefulness feedback degraded: ${(err as Error).message}`);
      }
      try {
        await recordSessionSummaryActivation({
          sessionManager: infra.sessionManager,
          sessionId,
          summary: ctx.sessionSummary,
          usedSummaryId: usedContinuitySummaryId,
          runId: ctx.runId,
          status: signal?.aborted ? 'aborted' : stageResult.ok ? 'ok' : 'error',
          verification: latestVerification,
          successfulToolCallIds,
          recordedAt,
        });
      } catch (err) {
        opts.log?.('warn', `runner: session summary activation degraded: ${(err as Error).message}`);
      }
      try {
        memoryAccess = await infra.memoryService.finishRun(ctx.runId);
      } catch (err) {
        opts.log?.('warn', `runner: run resource cleanup degraded: ${(err as Error).message}`);
      }
      const runAborted = signal?.aborted === true;

      // Compact only after the run has finalized and persisted its messages.
      // The transcript remains intact; failures only skip the optional summary.
      if (!runAborted) {
        try {
          const compacted = await maybeCompact(infra.sessionManager, sessionId, {
            threshold: opts.config.sessions.compaction.threshold,
            keepRecent: opts.config.sessions.compaction.keepRecent,
            force: ctx.contextSnapshots?.some((snapshot) => snapshot.compressionRecommended) === true,
            signal,
            summarize: async ({ previousSummary, messages }) => {
              const summaryMessages: ChatMessage[] = [
                {
                  role: 'system',
                  content: `You maintain a versioned session summary for an AI agent. Preserve user goals, constraints, decisions, unfinished work, important facts, permission outcomes, artifact paths, and source message ids. Remove repetition and verbose tool output. Do not invent facts. Return only the summary text.`,
                },
                {
                  role: 'user',
                  content: [
                    previousSummary ? `Previous summary:\n${previousSummary.summary}\n` : '',
                    'New messages to merge:',
                    ...messages.map(renderMessageForCompaction),
                  ].filter(Boolean).join('\n\n'),
                },
              ];
              const rawRequest = {
                model,
                messages: summaryMessages,
                temperature: 0,
                max_tokens: 1_400,
                signal,
              } satisfies ChatRequest;
              const request = prepareModelRequest(
                ctx,
                'session_compaction',
                rawRequest,
                buildRunRequestCandidates(ctx, 'capture', rawRequest.messages, {
                  history: [],
                  primaryUserKind: 'workflow_state',
                }),
              );
              const response = await infra.llm.chat(request);
              recordProviderUsage(ctx, request, response.usage);
              return { summary: response.content, model: response.model ?? model };
            },
          });
          if (compacted) {
            try {
              await infra.memoryService.registerSessionSummary(sessionId, compacted);
            } catch (err) {
              opts.log?.('warn', `runner: summary resource registration degraded: ${(err as Error).message}`);
            }
            try {
              const consolidation = await infra.memoryService.consolidateDailyMemory({
                sessionId,
                workspace: cwd,
                runId: ctx.runId,
                summary: compacted,
              });
              if (consolidation.failures.length > 0) {
                opts.log?.('warn', 'runner: daily memory consolidation retained source atoms after partial failure.', {
                  promoted: consolidation.promoted,
                  archived: consolidation.archived,
                  failures: consolidation.failures,
                });
              }
            } catch (err) {
              opts.log?.('warn', `runner: daily memory consolidation skipped: ${(err as Error).message}`);
            }
          }
        } catch (err) {
          opts.log?.('warn', `runner: session compaction skipped: ${(err as Error).message}`);
        }
      }

      // 6. Wrap into RunnerResult.
      const result = assembleResult(stageResult, ctx, sessionId, startedAt, runAborted, memoryAccess);

      // 7. M3: persist execution log (one JSON per run). Failure is non-fatal —
      //    the run result is still returned; only the audit log is lost.
      try {
        await infra.executionLogStore.write({
          runId: result.runId,
          sessionId: result.sessionId,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          status: result.status,
          model,
          inboundText: input.text,
          reply: result.reply ?? '',
          error: result.error,
          trace: result.trace,
          taskExecution: result.taskExecution,
          taskBook: result.taskBook,
          verificationHistory: result.verificationHistory,
          memoryIntentDecisions: result.memoryIntentDecisions,
          memoryKnownState: result.memoryKnownState,
          clarificationRequest: result.clarificationRequest,
          clarificationResponse: result.clarificationResponse,
          memoryAccess: result.memoryAccess,
          resolvedRunConfig: result.resolvedRunConfig,
          modelRequests: result.modelRequests,
          contextSnapshots: result.contextSnapshots,
          runtimeResources: completeRuntimeResourceObservation(runtimeResourceStart),
          messages: result.messages,
          durationMs: result.durationMs,
        });
      } catch (err) {
        opts.log?.('error', `runner: failed to write execution log: ${(err as Error).message}`);
      }

      try {
        await infra.executionLogStore.writeLatestForSession(sessionId, buildSessionRunSummary({
          runId: result.runId,
          status: result.status,
          startedAtMs: startedAt,
          durationMs: result.durationMs,
          messages: result.messages,
          taskExecution: result.taskExecution,
          taskBook: result.taskBook,
        }));
      } catch (err) {
        opts.log?.('warn', `runner: failed to persist last-run timing summary: ${(err as Error).message}`);
      }

      if (activeCheckpoint) {
        checkpointCompleted = await completeRunVersionCheckpoint({
          checkpoint: activeCheckpoint,
          result,
          sessionId,
          startedAtMs: startedAt,
          executionLogStore: infra.executionLogStore,
          log: opts.log,
        });
      }

      return result;
    } finally {
      if (activeCheckpoint && !checkpointCompleted) {
        try {
          await activeCheckpoint.abort();
        } catch (err) {
          opts.log?.('error', `runner: failed to freeze interrupted run: ${(err as Error).message}`);
        }
      }
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  return {
    run,
    runStream: (input: RunInput, onDelta: (delta: string) => void) =>
      run({ ...input, onAssistantDelta: onDelta }),
    replay: (runId: string) => infra.executionLogStore.read(runId),
    shutdown: async () => {
      // Close long-lived SQLite connections before adapters replace or delete the data root.
      await infra.memoryRepository.shutdown();
      await infra.disposeEmbedding();
      await infra.versioning?.freeze();
    },
    state,
    sessionManager: infra.sessionManager,
    infra,
    model,
  };
}

function renderMessageForCompaction(message: Message): string {
  const body = message.content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'reasoning') return '[reasoning]\n' + block.text;
    if (block.type === 'tool_calls') {
      return '[tool calls] ' + block.calls.map((call) => call.name + '#' + call.id).join(', ');
    }
    const output = block.result.output === undefined
      ? ''
      : ' output=' + truncateCompactionText(safeCompactionJson(block.result.output), 1_200);
    const error = block.result.error ? ' error=' + block.result.error : '';
    return '[tool result ' + block.result.callId + '] ok=' + block.result.ok + output + error;
  }).join('\n');
  return '[source message ' + message.id + ' | ' + message.timestamp + ' | ' + message.role + ']\n'
    + truncateCompactionText(body, 4_000);
}

function safeCompactionJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  } catch {
    return '[non-serializable]';
  }
}

function truncateCompactionText(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max) + '\n[truncated ' + (value.length - max) + ' characters]';
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
    error: stageResult.error,
    messages: ctx.produced,
    trace,
    durationMs: Date.now() - startedAtMs,
    usage: ctx.usage,
    resolvedRunConfig: ctx.resolvedRunConfig,
    modelRequests: ctx.modelRequests,
    contextSnapshots: ctx.contextSnapshots,
    taskExecution: ctx.taskExecution,
    taskBook: ctx.taskBook ? { ...ctx.taskBook, stageResults: undefined } : undefined,
    verificationHistory: ctx.verificationHistory,
    memoryIntentDecisions: ctx.memoryIntentDecisions,
    memoryKnownState: ctx.memoryKnownState,
    clarificationRequest: ctx.clarificationRequest,
    clarificationResponse: ctx.clarificationResponse,
    memoryAccess,
  };
}
