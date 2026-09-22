// @littlesheep/harness — context.ts
// buildRunContext: assembles a RunContext before the harness runs.
//
// Called by the entry layer (gateway/cli/test) BEFORE harness.run(ctx).
// Loads session history and bootstrap files; constructs the
// ToolContext. Infrastructure (llm/sessionManager/memoryStore) is NOT put in
// RunContext — stages capture those via closure in createDefaultHarness.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  RunContext,
  Message,
  AgentTool,
  ToolContext,
  SessionId,
  MemoryStoreLike,
  ClarificationRequest,
  ClarificationResponse,
  ResolvedRunConfig,
  RuntimeCapabilitySnapshot,
  RuntimeCapabilityProbe,
  RuntimePermissionEvent,
  RuntimeEventQueueLike,
  CacheObservation,
} from '@littlesheep/types';
import { filterAuthoritativeUserFacingMessages, sanitizeWebEvidenceProjection } from '@littlesheep/types';
import type { SessionManager } from '@littlesheep/session';
import type { MemoryBootstrapServiceLike } from '@littlesheep/memory-tree';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import { applyBootstrapLimits } from '@littlesheep/prompt';
import { resolveRuntimeTimeZone } from '@littlesheep/prompt';
import { writeRuntimeState } from './runtime-state.js';
import { writeMemoryState } from './memory-state.js';
import { writeDecisionState } from './decision-state.js';
import { writeFailureState } from './failure-state.js';
import { writeExecutionEvidenceState } from './execution-evidence-state.js';
import { writeModelObservabilityState } from './model-observability-state.js';

/** Bootstrap file names (in priority order). Read from bootstrapDir. */
const BOOTSTRAP_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md'] as const;

function messageText(message: Message): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Everything the last compaction did not summarize, in transcript order.
 *
 * The summary's `sourceEndMessageId` is the boundary it covers; the messages after
 * it are the verbatim task interval. Without a summary the whole transcript is the
 * interval, which is what lets a session grow append-only until real context
 * pressure folds it once.
 */
function messagesAfterCompaction(
  messages: readonly Message[],
  compaction: { sourceEndMessageId?: string } | undefined,
): Message[] {
  const cursor = compaction?.sourceEndMessageId;
  if (!cursor) return [...messages];
  const index = messages.findIndex((message) => message.id === cursor);
  return index < 0 ? [...messages] : messages.slice(index + 1);
}

/** A clarification is pending only when it is the latest conversational turn. */
function latestPendingClarification(history: Message[]): ClarificationRequest | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    return message.role === 'assistant' ? message.clarificationRequest : undefined;
  }
  return undefined;
}

/** Options for buildRunContext. */
export interface BuildRunContextOptions {
  /** Session this run belongs to. */
  sessionId: SessionId;
  /** The inbound user message that starts this run. */
  inbound: Message;
  /** Session manager (for loading history). */
  sessionManager: SessionManager;
  /** Memory store retained for compatibility; runtime recall now uses MemoryTree. */
  memoryStore: MemoryStoreLike;
  /** Tools available to EXECUTE stage. */
  tools: AgentTool[];
  /** Registry source for every tool available to EXECUTE. */
  toolSources?: Record<string, string>;
  /** Resolved config. */
  config: Config;
  /** Branding (for prompt assembly downstream). */
  branding: BrandingConfig;
  /** Model ref (provider/model). */
  model: string;
  /** Optional run id (auto-generated if absent). */
  runId?: string;
  /** Exact owning-run start time, when already known by the caller. */
  startedAt?: string;
  /** Working directory for file/exec tools (defaults to process.cwd()). */
  cwd?: string;
  /** Host-owned roots that built-in mutation tools must keep read-only. */
  protectedWriteRoots?: readonly string[];
  /** Active movable application-data root used as the logical LS container. */
  containerRoot?: string;
  /** Resolved permission policy, when the owning adapter supplies a container. */
  permissionMode?: import('@littlesheep/types').PermissionPolicyId;
  /** Abort signal for the owning run. */
  signal?: AbortSignal;
  /** Approval callback handed to tools. */
  approve?: ToolContext['approve'];
  /** Logger sink handed to tools. */
  log?: ToolContext['log'];
  /** Run-scoped durable preimage checkpoint hooks handed to mutating tools. */
  versioning?: ToolContext['versioning'];
  /** Optional assistant text delta callback for streaming callers. */
  onAssistantDelta?: (delta: string) => void;
  /** Replace provisional streamed text with the approved final reply. */
  onAssistantReplace?: (text: string) => void;
  /** Optional tool event callback forwarded to RunContext for real-time streaming. */
  onToolEvent?: (evt: import('@littlesheep/types').ToolStreamEvent) => void;
  /** Extra system prompt injected by the active general/coding behavior profile. */
  profilePromptAddon?: string;
  /** Prompt guidance for the selected reasoning budget. */
  reasoningPromptAddon?: string;
  /** Attachments for this run. */
  attachments?: import('@littlesheep/types').RunAttachment[];
  /** Immutable configuration resolved by Runner before the harness starts. */
  resolvedRunConfig?: ResolvedRunConfig;
  /** Process-held data-root-local HMAC key; never copied into checkpoints. */
  cacheObservationKey?: string | null;
  /** Last authorized observation for this scope, used to explain cross-run cache changes. */
  previousCacheObservation?: import('@littlesheep/types').CacheObservation;
  /** Non-blocking persistence hook for redacted cache observations. */
  persistCacheObservation?: (observation: CacheObservation) => Promise<void>;
  /** Runtime-owned path-free capability facts resolved before the run starts. */
  capabilitySnapshot?: RuntimeCapabilitySnapshot;
  capabilityProbe?: RuntimeCapabilityProbe;
  capabilityPermissionEvent?: RuntimePermissionEvent;
  /** Host-owned per-run public web retrieval port. */
  webRetrieval?: ToolContext['webRetrieval'];
  /** Host-owned bounded web evidence sink. */
  webEvidenceSink?: ToolContext['webEvidenceSink'];
  /** Run-owned bounded event queue consumed only at Harness safe boundaries. */
  runtimeEventQueue?: RuntimeEventQueueLike;
  /** Ordered durable event sink owned by the Runner/runtime adapter. */
  appendDurableEvent?: RunContext['appendDurableEvent'];
  /** Cross-process effect ownership owned by the Runner/runtime adapter. */
  effectLeases?: RunContext['effectLeases'];
  /** Defer final-reply settlement until Runner-owned audit persistence completes. */
  deferFinalReplySettlement?: boolean;
  /** Transcript opt-in; see RunContext.streamModelTranscript. */
  streamModelTranscript?: boolean;
  /** Directory containing bootstrap .md files (defaults to cwd). */
  bootstrapDir?: string;
  /** Unified memory/resource service used to register and load bootstrap authorities. */
  memoryResources?: MemoryBootstrapServiceLike;
  /** Message ids that are already represented by a resumed inbound message. */
  historyExcludeMessageIds?: readonly string[];
  /** Workspace ownership context retained for a continuation run. */
  workspaceContext?: {
    boundaryKind: import('@littlesheep/memory-tree').WorkspaceBoundaryKind;
    projectId?: string;
  };
}

/**
 * Read only prompt-resident bootstrap files. MEMORY/PHILOSOPHY remain indexed resources.
 * Missing files are skipped (not errors). Returns a map keyed by stem
 * (e.g. "AGENTS" → contents).
 */
export async function readBootstrapFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of BOOTSTRAP_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const content = await readFile(path, 'utf8');
      // Key by stem (AGENTS.md → "AGENTS.md" keeps full filename for prompt section).
      out[file] = content;
    } catch {
      // read error → skip (treat as missing)
    }
  }
  return out;
}

/**
 * Assemble a fully-resolved RunContext ready to hand to harness.run().
 *
 * Loads: recent session history and bootstrap files
 * (with per-file + total limits applied), and constructs the ToolContext.
 */
export async function buildRunContext(opts: BuildRunContextOptions): Promise<RunContext> {
  const runId = opts.runId ?? randomUUID();
  const cwd = opts.cwd ?? process.cwd();
  const bootstrapDir = opts.bootstrapDir ?? cwd;

  // 1. The task interval's transcript: everything the last compaction did not fold
  // into the summary, plus this run's own appends.
  //
  // It used to be the last `compaction.keepRecent` conversational messages, which
  // re-floored the window on every turn once a session grew past it: the replayed
  // history then started at a different message each turn, so the request stopped
  // extending the previous one and the Provider re-billed the whole prompt.
  // Measured on the 28-turn long task (no compaction involved): from turn 3 on, the
  // first divergence was at message 1 and 417k tokens were re-billed. The
  // compaction cursor is the real floor — it is the boundary a summary already
  // covers — and the context budget, not a message count, decides when more has to
  // be folded in.
  const [allMessages, sessionMetadata] = await Promise.all([
    opts.sessionManager.read(opts.sessionId),
    opts.sessionManager.loadMetadata(opts.sessionId),
  ]);
  const rawHistory = messagesAfterCompaction(allMessages, sessionMetadata?.compaction);
  const authoritativeHistory = filterAuthoritativeUserFacingMessages(rawHistory);
  const pendingClarification = latestPendingClarification(authoritativeHistory);
  const clarificationResponse: ClarificationResponse | undefined = pendingClarification
    ? {
        requestId: pendingClarification.id,
        answer: messageText(opts.inbound),
        answeredAt: opts.inbound.timestamp,
      }
    : undefined;
  if (clarificationResponse) {
    opts.inbound.clarificationResponse = clarificationResponse;
  }
  // Prose-only projection for user-facing and continuity consumers. Tool
  // messages and Runtime tail sections stay out of it; `modelHistory` below is
  // the projection the model replays, and it keeps the tool calls, their results
  // and the tail sections the Provider already cached.
  const excludedMessageIds = new Set(opts.historyExcludeMessageIds ?? []);
  const history = authoritativeHistory.filter((m) => {
    if (excludedMessageIds.has(m.id)) return false;
    if (m.role === 'tool' || m.runtimeTail === true) return false;
    return m.content.some((c) => c.type === 'text');
  });
  // The task-interval replay: the same persisted messages, tail sections and tool
  // pairs included, so a new run extends the previous run's request prefix
  // instead of rebuilding a shorter history. Bounded by
  // `sessions.compaction.keepRecent` (the compaction boundary is the real limit);
  // `projectModelHistory` only guards against a pathological request.
  const modelHistory = authoritativeHistory.filter((m) => !excludedMessageIds.has(m.id));

  // 2. Bootstrap files (MEMORY.md is deliberately excluded; MemoryTree indexes it).
  const rawBootstrap = opts.memoryResources
    ? await opts.memoryResources.loadBootstrapFiles(bootstrapDir)
    : await readBootstrapFiles(bootstrapDir);
  const bootstrap = applyBootstrapLimits(
    rawBootstrap,
    opts.config.agents.defaults.bootstrapMaxChars,
    opts.config.agents.defaults.bootstrapTotalMaxChars,
  );

  // 3. Tool execution context.
  const toolContext: ToolContext = {
    sessionId: opts.sessionId,
    runId,
    cwd,
    protectedWriteRoots: opts.protectedWriteRoots,
    containerRoot: opts.containerRoot,
    permissionMode: opts.permissionMode,
    approve: opts.approve,
    signal: opts.signal,
    networkPolicy: opts.resolvedRunConfig?.networkPolicy,
    webRetrieval: opts.webRetrieval,
    webEvidenceSink: opts.webEvidenceSink,
    log: opts.log,
    versioning: opts.versioning,
  };

  // 4. Assemble RunContext.
  const ctx: RunContext = {
    runId,
    sessionId: opts.sessionId,
    inbound: opts.inbound,
    cwd,
    workspaceContext: opts.workspaceContext,
    model: opts.model,
    tools: opts.tools,
    toolSources: opts.toolSources,
    toolContext,
    bootstrap,
    history,
    modelHistory,
    produced: [],
    taskBookRevision: 0,
    appliedTaskBookPatchIds: [],
    maxRecoveryAttempts: opts.config.agents.defaults.maxRecoveryAttempts,
    // VERIFY bounded iteration: replan budget (default 2). When exhausted the run
    // stops instead of replanning again; there is no separate planner stage to
    // loop back into.
    replanAttempts: 0,
    maxReplanAttempts: 2,
    startedAt: opts.startedAt ?? new Date().toISOString(),
    timeZone: resolveRuntimeTimeZone(opts.config.agents.defaults.userTimezone),
    timeFormat: opts.config.agents.defaults.timeFormat,
    onAssistantDelta: opts.onAssistantDelta,
    onAssistantReplace: opts.onAssistantReplace,
    onToolEvent: opts.onToolEvent,
    profilePromptAddon: opts.profilePromptAddon,
    reasoningPromptAddon: opts.reasoningPromptAddon,
    attachments: opts.attachments,
    resolvedRunConfig: opts.resolvedRunConfig,
    appendDurableEvent: opts.appendDurableEvent,
    effectLeases: opts.effectLeases,
    ...(opts.deferFinalReplySettlement ? { deferFinalReplySettlement: true } : {}),
    ...(opts.streamModelTranscript ? { streamModelTranscript: true } : {}),
    ...(opts.cacheObservationKey !== undefined ? { cacheObservationKey: opts.cacheObservationKey } : {}),
    ...(opts.previousCacheObservation ? { previousCacheObservation: opts.previousCacheObservation } : {}),
    ...(opts.persistCacheObservation ? { persistCacheObservation: opts.persistCacheObservation } : {}),
    ...(opts.capabilitySnapshot ? { capabilitySnapshot: opts.capabilitySnapshot } : {}),
    ...(opts.capabilityProbe ? { capabilityProbe: opts.capabilityProbe } : {}),
    ...(opts.capabilityPermissionEvent ? { capabilityPermissionEvent: opts.capabilityPermissionEvent } : {}),
    reserveUserFacingReply: typeof opts.sessionManager.reserveAssistantReply === 'function'
      ? (reply) => opts.sessionManager.reserveAssistantReply(opts.sessionId, reply)
      : undefined,
    reserveUserFacingReplySettlement: typeof opts.sessionManager.reserveAssistantReplySettlement === 'function'
      ? (reservation) => opts.sessionManager.reserveAssistantReplySettlement!(opts.sessionId, reservation)
      : undefined,
    settleUserFacingReplySettlement: typeof opts.sessionManager.settleAssistantReplySettlement === 'function'
      ? (reservation) => opts.sessionManager.settleAssistantReplySettlement!(opts.sessionId, reservation)
      : undefined,
    maxModelCalls: opts.config.agents.defaults.maxModelCallsPerRun,
    contextCompressionThresholdRatio: opts.config.agents.defaults.contextCompressionThresholdRatio,
    signal: opts.signal,
  };

  // Web tools receive a narrow runtime port, but the RunContext remains the
  // sole durable owner of the bounded evidence projection. A caller may add
  // an observer, never replace this ownership boundary.
  if (opts.webRetrieval || opts.webEvidenceSink) {
    const observer = opts.webEvidenceSink;
    toolContext.webEvidenceSink = {
      async record(projection) {
        const durable = sanitizeWebEvidenceProjection(projection);
        if (!durable) return;
        ctx.webEvidence = durable;
        await observer?.record(structuredClone(durable));
      },
    };
  }

  writeDecisionState(ctx, 'runner-init', { clarificationResponse });
  writeFailureState(ctx, 'runner-init', { recoveryAttempts: 0 });
  writeExecutionEvidenceState(ctx, 'runner-init', {
    toolInvocations: [],
    toolInvocationsTruncated: false,
    sideEffects: [],
  });
  writeModelObservabilityState(ctx, 'runner-init', {
    modelCallCount: 0,
    modelRequests: [],
    contextSnapshots: [],
  });

  writeRuntimeState(ctx, 'runner-init', {
    runtimeEventQueue: opts.runtimeEventQueue,
    deferredRuntimeEventIds: [],
    deferredRuntimeEvents: [],
    loopBudget: {
      attemptsUsed: 0,
      maxAttempts: opts.config.agents.defaults.maxModelCallsPerRun,
      elapsedMs: 0,
      maxElapsedMs: 0,
      noProgressRounds: 0,
      maxNoProgressRounds: 2,
    },
  });
  // A summary produced before the latest correction/forget must not be injected
  // as current memory; the user's explicit revocation wins over cached prose.
  const summary = sessionMetadata?.compaction;
  const revokedAt = sessionMetadata?.memoryRevokedAt;
  const summaryIsRevoked = Boolean(summary && revokedAt && summary.compactedAt < revokedAt);
  writeMemoryState(ctx, 'runner-init', { sessionSummary: summaryIsRevoked ? undefined : summary });

  return ctx;
}
