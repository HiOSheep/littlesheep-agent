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
  SessionRunSummary,
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
  /** Bounded execution facts from the preceding run. */
  previousRun?: SessionRunSummary;
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
  /** Next-Harness transcript opt-in; see RunContext.streamModelTranscript. */
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

  // 1. Recent session history (respect compaction keepRecent).
  const keepRecent = opts.config.sessions.compaction.keepRecent;
  const [rawHistory, sessionMetadata] = await Promise.all([
    opts.sessionManager.readRecent(opts.sessionId, keepRecent),
    opts.sessionManager.loadMetadata(opts.sessionId),
  ]);
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
  // Filter tool messages: they're persisted to session JSONL for replay/audit
  // (M3) but must not enter the LLM context — toChatMessage maps 'tool' role to
  // 'user' and extracts empty text from tool_calls/tool_result blocks, which
  // would pollute the conversation. EXECUTE rebuilds tool messages each run.
  const excludedMessageIds = new Set(opts.historyExcludeMessageIds ?? []);
  const history = authoritativeHistory.filter((m) => {
    if (excludedMessageIds.has(m.id)) return false;
    if (m.role === 'tool') return false;
    return m.content.some((c) => c.type === 'text');
  });

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
    previousRun: opts.previousRun,
    produced: [],
    taskBookRevision: 0,
    appliedTaskBookPatchIds: [],
    maxRecoveryAttempts: opts.config.agents.defaults.maxRecoveryAttempts,
    // VERIFY bounded iteration: replan budget (default 2). When exhausted,
    // VERIFY force-passes to EVOLVE to avoid infinite DECIDE↔VERIFY loops.
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
  writeMemoryState(ctx, 'runner-init', { sessionSummary: sessionMetadata?.compaction });

  return ctx;
}
