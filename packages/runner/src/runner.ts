// @littlesheep/runner — runner.ts
// Shared agent runner: assemble infra from config, expose run().
// Used by both the Electron APP (local conversations, origin='app') and the
// channel gateway service (channel-routed conversations, origin='channel').

import type {
  AgentResult,
  Message,
  RunContext,
  SessionId,
  SessionMetadata,
  StageResult,
  ToolContext,
} from '@littlesheep/types';
import { asSessionId, textMessage } from '@littlesheep/types';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import type { LlmClient } from '@littlesheep/llm';
import { SessionManager } from '@littlesheep/session';
import { buildRunContext } from '@littlesheep/harness';
import { buildInfrastructure, type GatewayState, type LogFn } from './infra.js';
import type { ExecutionLog } from './execution-log.js';
import type { MemoryAccessLedger } from '@littlesheep/memory-tree';
import { getAgentProfile, type AgentProfileId } from '@littlesheep/prompt';

/** AgentResult + sessionId (caller-friendly). */
export type RunnerResult = AgentResult & { sessionId: SessionId; memoryAccess?: MemoryAccessLedger };

/** Identifies the call origin — affects execution log archiving and tool approvals. */
export type RunOrigin = 'app' | 'channel' | 'cli' | 'test';

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
  /** Directory containing AGENTS/USER/TOOLS/MEMORY/SOUL bootstrap files. */
  bootstrapDir?: string;
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
  /** Per-run reasoning budget selected by the user. */
  reasoning?: Config['agents']['defaults']['reasoning'];
  /** General/coding behavior profile. Permission policy is configured separately. */
  profile?: AgentProfileId;
  /** Optional tool event callback for real-time streaming (SSE tool_start/tool_end). */
  onToolEvent?: (evt: import('@littlesheep/types').ToolStreamEvent) => void;
  /** Per-run attachments. Image data URLs are sent to vision-capable models. */
  attachments?: import('@littlesheep/types').RunAttachment[];
}

export interface AgentRunner {
  run(input: RunInput): Promise<RunnerResult>;
  runStream(input: RunInput, onDelta: (delta: string) => void): Promise<RunnerResult>;
  /** Replay a past run by id (reads execution log). Returns null if not found. */
  replay(runId: string): Promise<ExecutionLog | null>;
  shutdown(): Promise<void>;
  readonly state: GatewayState;
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
  const state: GatewayState = { sessionId: undefined, model };
  const infra = await buildInfrastructure({
    config: opts.config,
    branding: opts.branding,
    model,
    llm: opts.llm,
    skillsDirs: opts.skillsDirs,
    state,
    log: opts.log,
  });

  // Overall run timeout. When run is called without a signal, a timed
  // AbortController is created so a hung tool/LLM can't block indefinitely.
  // 0 disables. Tools and llm.chat both respect ctx.signal (→ toolContext.signal).
  const RUN_TIMEOUT_MS = opts.runTimeoutMs ?? 5 * 60 * 1000;

  async function run(input: RunInput): Promise<RunnerResult> {
    const startedAt = Date.now();

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
      // 1. Resolve or create session.
      let sessionId: SessionId;
      if (input.sessionId) {
        sessionId = input.sessionId;
      } else {
        // Build metadata for channel-bound sessions so listByChannel() works.
        // origin is also stamped on app/cli sessions for UI provenance.
        // 'test' origin is omitted from metadata (not a user-visible origin).
        const origin = input.origin ?? 'cli';
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
      const inbound: Message = textMessage('user', input.text, { sessionId });

      // 3. Build RunContext (loads history WITHOUT inbound — no duplicate).
      const cwd = input.cwd ?? opts.config.agents.defaults.workspace;

      // Apply caller-provided tool policy before the run.
      let resolvedTools = infra.registry.list().map((r) => r.tool);
      if (input.toolFilter) {
        resolvedTools = resolvedTools.filter(input.toolFilter);
      }
      if (input.requireApprovalForAllTools) {
        resolvedTools = resolvedTools.map((tool) => ({ ...tool, requiresApproval: true }));
      }

      const behaviorProfile = getAgentProfile(input.profile ?? opts.config.agents.defaults.profile);
      const ctx: RunContext = await buildRunContext({
        sessionId,
        inbound,
        sessionManager: infra.sessionManager,
        memoryStore: infra.memoryStore,
        tools: resolvedTools,
        config: opts.config,
        branding: opts.branding,
        model,
        cwd,
        signal,
        approve: input.approve ?? opts.approve,
        log: opts.log,
        onAssistantDelta: input.onAssistantDelta,
        onToolEvent: input.onToolEvent,
        profilePromptAddon: behaviorProfile?.systemPromptAddon,
        reasoningPromptAddon: reasoningPromptAddon(input.reasoning ?? opts.config.agents.defaults.reasoning),
        attachments: input.attachments,
        bootstrapDir: opts.bootstrapDir,
      });
      try {
        infra.memoryTree.beginRun({
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
          workspace: cwd,
          signal,
        });
        ctx.memoryRootIndex = infra.memoryTree.rootIndex();
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
      } finally {
        memoryAccess = infra.memoryTree.finishRun(ctx.runId);
      }

      // 6. Wrap into RunnerResult.
      const result = assembleResult(stageResult, ctx, sessionId, startedAt, signal, memoryAccess);

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
          clarificationRequest: result.clarificationRequest,
          clarificationResponse: result.clarificationResponse,
          memoryAccess: result.memoryAccess,
          messages: result.messages,
          durationMs: result.durationMs,
        });
      } catch (err) {
        opts.log?.('error', `runner: failed to write execution log: ${(err as Error).message}`);
      }

      return result;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  return {
    run,
    runStream: (input: RunInput, onDelta: (delta: string) => void) =>
      run({ ...input, onAssistantDelta: onDelta }),
    replay: (runId: string) => infra.executionLogStore.read(runId),
    shutdown: async () => {
      // Close the vector store's SQLite connection (MCP servers would close here too).
      infra.vectorStore.close();
    },
    state,
    sessionManager: infra.sessionManager,
    infra,
    model,
  };
}

function reasoningPromptAddon(reasoning: Config['agents']['defaults']['reasoning']): string | undefined {
  switch (reasoning) {
    case 'low':
      return 'Reasoning budget: low. Prefer a direct answer or the smallest safe tool plan.';
    case 'medium':
      return 'Reasoning budget: medium. Balance speed with enough planning to avoid obvious mistakes.';
    case 'high':
      return 'Reasoning budget: high. Think through edge cases before acting and verify important results.';
    case 'ultra':
      return 'Reasoning budget: ultra. Use a careful multi-step approach, inspect assumptions, and verify thoroughly before finalizing.';
    case 'auto':
    default:
      return undefined;
  }
}

function assembleResult(
  stageResult: StageResult,
  ctx: RunContext,
  sessionId: SessionId,
  startedAtMs: number,
  signal?: AbortSignal,
  memoryAccess?: MemoryAccessLedger,
): RunnerResult {
  const status: AgentResult['status'] = signal?.aborted
    ? 'aborted'
    : stageResult.ok
      ? 'ok'
      : 'error';
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
    taskExecution: ctx.taskExecution,
    taskBook: ctx.taskBook ? { ...ctx.taskBook, stageResults: undefined } : undefined,
    verificationHistory: ctx.verificationHistory,
    clarificationRequest: ctx.clarificationRequest,
    clarificationResponse: ctx.clarificationResponse,
    memoryAccess,
  };
}
