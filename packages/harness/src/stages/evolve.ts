// @littlesheep/harness - EVOLVE proposes structured durable memories/skills.

import type { LlmMemoryIntentKind, RunContext, StageResult } from '@littlesheep/types';
import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import {
  InjectionTier,
  type MemoryAtomCorrectionServiceLike,
  type MemoryAtomHierarchyServiceLike,
  type MemoryBranchKind,
  type MemoryAtomReconciliationServiceLike,
  type MemoryAtomRevisionServiceLike,
  type MemoryAtomSubtreeServiceLike,
  type MemoryScope,
  type MemoryWriteIntent,
  type MemoryWriteServiceLike,
} from '@littlesheep/memory-tree';
import { textOf, callLlmForJson, asStringArray } from './_shared.js';
import {
  prepareModelRequest,
  recordProviderUsage,
  ensureModelRequestStarted,
  recordModelRequestFailure,
} from '../model-observability.js';
import { buildRunRequestCandidates } from '../context-candidates.js';
import {
  commitMemoryIntentBatch,
  evaluateMemoryIntent,
  memoryWriteEvidenceRefs,
  memoryWriteSourceRefs,
  type GatedMemoryProposal,
} from './memory-intent-gate.js';
import { resolveMemoryWriteEpistemic } from './memory-epistemic-policy.js';
import { EVOLVE_MEMORY_PROMPT } from './memory-stage-prompts.js';
import { processEvolveReconciliations } from './evolve/reconciliation.js';
import { processEvolveReparents } from './evolve/hierarchy.js';
import { processEvolveSubtreeMoves } from './evolve/subtree.js';
import { processEvolveRevisions } from './evolve/revision.js';
import { processEvolveCorrections } from './evolve/correction.js';
import { hasExplicitEvolutionRequest, hasReusableEvolutionSignal } from './evolve/signal.js';
import { parseSkillProposal } from './evolve/skill-proposal.js';
import { writeMemoryState } from '../memory-state.js';
import { hasCleanVerification } from '../verification-state.js';

export type CreateSkillFn = (opts: {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
}) => Promise<string>;

export interface EvolveStageDeps {
  llm: LlmClient;
  model: string;
  memoryWriter?: MemoryWriteServiceLike;
  memoryReconciler?: MemoryAtomReconciliationServiceLike;
  memoryHierarchy?: MemoryAtomHierarchyServiceLike;
  memorySubtree?: MemoryAtomSubtreeServiceLike;
  memoryReviser?: MemoryAtomRevisionServiceLike;
  memoryCorrector?: MemoryAtomCorrectionServiceLike;
  createSkill?: CreateSkillFn;
  llmPolicy?: 'adaptive' | 'always' | 'never';
  mode?: 'legacy' | 'explicit-only';
}

interface MemoryProposal {
  intent?: unknown;
  branch?: unknown;
  parentNodeId?: unknown;
  scope?: unknown;
  summary?: unknown;
  content?: unknown;
  retrievalKeys?: unknown;
  importance?: unknown;
  confidence?: unknown;
  reason?: unknown;
  epistemic?: unknown;
}

interface DecodedEvolve {
  memories?: unknown;
  reconciliations?: unknown;
  reparents?: unknown;
  subtreeMoves?: unknown;
  revisions?: unknown;
  corrections?: unknown;
  /** Accepted only for old persisted mocks; never written without the new contract. */
  notes?: unknown;
  createSkill?: unknown;
}

const BRANCHES = new Set<MemoryBranchKind>(['long-term', 'project', 'experience']);
const SCOPES = new Set<MemoryScope>(['global', 'workspace', 'project']);
const INTENTS = new Set<LlmMemoryIntentKind>(['read', 'write', 'merge', 'move', 'revise', 'invalidate', 'conflict', 'none']);

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function clampScore(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function stringArray(value: unknown, maxItems = 16): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanString(item, 80)).filter((item): item is string => !!item))].slice(0, maxItems);
}

function memoryProposals(value: unknown, ctx: RunContext): GatedMemoryProposal[] {
  if (!Array.isArray(value)) return [];
  const proposals: GatedMemoryProposal[] = [];
  for (const [index, raw] of value.slice(0, 8).entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const proposal = raw as MemoryProposal;
    const requestedIntent = cleanString(proposal.intent, 24) as LlmMemoryIntentKind | undefined;
    const intent = requestedIntent && INTENTS.has(requestedIntent) ? requestedIntent : 'write';
    const branch = cleanString(proposal.branch, 32) as MemoryBranchKind | undefined;
    const validBranch = branch && BRANCHES.has(branch) ? branch : undefined;
    const summary = cleanString(proposal.summary, 240);
    const content = cleanString(proposal.content, 4_000);
    const reason = cleanString(proposal.reason, 500);
    const retrievalKeys = stringArray(proposal.retrievalKeys);
    const importance = clampScore(proposal.importance);
    const confidence = clampScore(proposal.confidence);
    const gated = evaluateMemoryIntent({
      ctx,
      stage: 'evolve',
      intent,
      branch: validBranch,
      summary,
      importance,
      confidence,
      minImportance: validBranch === 'long-term' ? 0.7 : 0.5,
      minConfidence: validBranch === 'long-term' ? 0.75 : 0.7,
    });
    if (gated.action !== 'commit') {
      proposals.push(gated);
      continue;
    }
    if (!validBranch || !summary || !content || !reason || retrievalKeys.length === 0) {
      proposals.push({
        ...gated,
        action: 'reject',
        reason: 'A write or merge proposal must include a valid branch, summary, content, reason, and retrieval keys.',
      });
      continue;
    }
    const requestedScope = cleanString(proposal.scope, 24) as MemoryScope | undefined;
    const scope: MemoryScope = requestedScope && SCOPES.has(requestedScope)
      ? requestedScope
      : validBranch === 'project' ? 'workspace' : 'global';
    const scopeKey = scope === 'global' ? undefined : ctx.cwd;
    const requestedParent = cleanString(proposal.parentNodeId, 200);
    const writeIntent: MemoryWriteIntent = {
      id: `${ctx.runId}:evolve:memory-intent:${index + 1}`,
      branch: validBranch,
      parentNodeId: requestedParent ?? `${validBranch}:root`,
      scope,
      scopeKey,
      tier: InjectionTier.T2_RELEVANT,
      summary,
      content,
      retrievalKeys,
      sourceRunId: ctx.runId,
      sourceStage: 'evolve',
      sourceRefs: memoryWriteSourceRefs(gated),
      evidenceRefs: memoryWriteEvidenceRefs(gated),
      importance,
      confidence,
      reason,
      epistemic: resolveMemoryWriteEpistemic({
        raw: proposal.epistemic,
        stage: 'evolve',
        branch: validBranch,
        scope,
        scopeKey,
        sourceRefs: gated.sourceRefs,
        evidenceRefs: gated.evidenceRefs,
      }),
    };
    proposals.push({ ...gated, writeIntent });
  }
  return proposals;
}

export function createEvolveStage(deps: EvolveStageDeps) {
  return async function evolveStage(ctx: RunContext): Promise<StageResult> {
    const policy = deps.llmPolicy ?? 'always';
    const admitted = deps.mode === 'explicit-only'
      ? hasExplicitEvolutionRequest(ctx)
      : policy === 'always' || (policy === 'adaptive' && hasReusableEvolutionSignal(ctx));
    if (policy === 'never' || !admitted) {
      writeMemoryState(ctx, 'evolve', { evolutionNotes: [] });
      return {
        stage: 'evolve',
        next: 'capture',
        ok: true,
        meta: {
          skippedModelCall: true,
          reason: policy === 'never'
            ? 'disabled'
            : deps.mode === 'explicit-only' ? 'no-explicit-memory-request' : 'no-reusable-signal',
        },
      };
    }
    const executionSummary = ctx.taskExecution
      ? `${ctx.taskExecution.status}; ${ctx.taskExecution.steps.map((step) => `${step.stepId}:${step.status}`).join(', ')}`
      : '(no structured task execution)';
    const userMessage = [
      `Workspace: ${ctx.cwd}`,
      `Inbound: ${textOf(ctx.inbound).slice(0, 800)}`,
      `Execution: ${executionSummary}`,
      `Reply: ${(ctx.reply ?? '').slice(0, 1_000)}`,
      `Tool results: ${(ctx.toolResults ?? []).length} call(s)`,
    ].join('\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: EVOLVE_MEMORY_PROMPT },
      { role: 'user', content: userMessage },
    ];

    let parsed: DecodedEvolve | null = null;
    try {
      ({ parsed } = await callLlmForJson<DecodedEvolve>(deps.llm, deps.model, messages, {
        maxAttempts: 2,
        maxTokens: deps.createSkill ? 2_400 : 1_200,
        signal: ctx.signal,
        onRequest: (request, retry) => prepareModelRequest(
          ctx,
          'evolve',
          request,
          buildRunRequestCandidates(ctx, 'evolve', request.messages, {
            history: [],
            primaryUserKind: 'workflow_state',
          }),
          { retryOf: retry.previousRequestId, retryReason: retry.previousFailureReason },
        ),
        onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
        beforeRequest: (request) => ensureModelRequestStarted(ctx, request),
        onError: (request, error) => recordModelRequestFailure(ctx, request, error, ctx.signal),
      }));
    } catch {
      // Learning failure must not turn a completed user task into a failed run.
    }

    const proposals = memoryProposals(parsed?.memories, ctx);
    const legacyNotes = asStringArray(parsed?.notes);
    const { records, writeResults } = await commitMemoryIntentBatch(
      ctx,
      'evolve',
      deps.memoryWriter,
      proposals,
    );
    const reconciliation = await processEvolveReconciliations(
      parsed?.reconciliations,
      ctx,
      deps.memoryReconciler,
    );
    const hierarchy = await processEvolveReparents(
      parsed?.reparents,
      ctx,
      deps.memoryHierarchy,
    );
    const subtrees = await processEvolveSubtreeMoves(
      parsed?.subtreeMoves,
      ctx,
      deps.memorySubtree,
    );
    const revisions = await processEvolveRevisions(
      parsed?.revisions,
      ctx,
      deps.memoryReviser,
    );
    const corrections = await processEvolveCorrections(
      parsed?.corrections,
      ctx,
      deps.memoryCorrector,
    );
    writeMemoryState(ctx, 'evolve', {
      evolutionNotes: records
        .filter((record) => record.decision === 'committed' && record.summary)
        .map((record) => record.summary!)
        .concat(legacyNotes),
    });

    let skillCreated: string | null = null;
    const proposal = parseSkillProposal(parsed?.createSkill);
    if (deps.createSkill && proposal && hasCleanVerification(ctx)) {
      try { skillCreated = await deps.createSkill(proposal); } catch { /* non-fatal */ }
    }

    return {
      stage: 'evolve',
      next: 'capture',
      ok: true,
      meta: {
        proposedMemories: proposals.length,
        memoryWrites: writeResults.map((result) => ({ decision: result.decision, nodeId: result.node?.id, reason: result.reason })),
        memoryIntentDecisions: records.map((record) => ({
          intent: record.proposedIntent,
          decision: record.decision,
          reason: record.reason,
        })),
        memoryReconciliations: reconciliation.results.map((result) => ({
          proposalId: result.proposalId,
          status: result.status,
          targetAtomId: result.targetAtomId,
          committed: result.committedSourceAtomIds.length,
          remaining: result.remainingSourceAtomIds.length,
          reason: result.reason,
        })),
        memoryReconciliationDecisions: reconciliation.decisions.map((record) => ({
          decision: record.decision,
          reconciliationDecision: record.reconciliationDecision,
          reason: record.reason,
        })),
        memoryHierarchyChanges: hierarchy.results.map((result) => ({
          proposalId: result.proposalId,
          status: result.status,
          atomId: result.atomId,
          parentAtomId: result.parentAtomId,
          committed: result.committed,
          reason: result.reason,
        })),
        memoryHierarchyDecisions: hierarchy.decisions.map((record) => ({
          decision: record.decision,
          reconciliationDecision: record.reconciliationDecision,
          reason: record.reason,
        })),
        memorySubtreeMoves: subtrees.results.map((result) => ({
          proposalId: result.proposalId,
          status: result.status,
          rootAtomId: result.rootAtomId,
          parentAtomId: result.parentAtomId,
          activeDescendantCount: result.activeDescendantCount,
          committed: result.committed,
          reason: result.reason,
        })),
        memorySubtreeDecisions: subtrees.decisions.map((record) => ({
          decision: record.decision,
          reconciliationDecision: record.reconciliationDecision,
          reason: record.reason,
        })),
        memoryAtomRevisions: revisions.results.map((result) => ({
          proposalId: result.proposalId,
          status: result.status,
          atomId: result.atomId,
          committed: result.committed,
          previousRevision: result.previousRevision,
          revision: result.revision,
          reason: result.reason,
        })),
        memoryRevisionDecisions: revisions.decisions.map((record) => ({
          decision: record.decision,
          reconciliationDecision: record.reconciliationDecision,
          reason: record.reason,
        })),
        memoryAtomCorrections: corrections.results.map((result) => ({
          proposalId: result.proposalId,
          status: result.status,
          supersededAtomId: result.supersededAtomId,
          replacementAtomId: result.replacementAtomId,
          committed: result.committed,
          previousRevision: result.previousRevision,
          revision: result.revision,
          reason: result.reason,
        })),
        memoryCorrectionDecisions: corrections.decisions.map((record) => ({
          decision: record.decision,
          reconciliationDecision: record.reconciliationDecision,
          reason: record.reason,
        })),
        legacyNotesIgnored: legacyNotes.length,
        skillCreated,
      },
    };
  };
}
