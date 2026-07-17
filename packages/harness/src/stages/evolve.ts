// @littlesheep/harness - EVOLVE proposes structured durable memories/skills.

import type { LlmMemoryIntentKind, RunContext, StageResult } from '@littlesheep/types';
import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import {
  InjectionTier,
  type MemoryBranchKind,
  type MemoryScope,
  type MemoryWriteIntent,
  type MemoryWriteServiceLike,
} from '@littlesheep/memory-tree';
import { textOf, callLlmForJson, asStringArray } from './_shared.js';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
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
  createSkill?: CreateSkillFn;
  llmPolicy?: 'adaptive' | 'always' | 'never';
}

interface SkillProposal {
  name?: unknown;
  description?: unknown;
  whenToUse?: unknown;
  body?: unknown;
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
  /** Accepted only for old persisted mocks; never written without the new contract. */
  notes?: unknown;
  createSkill?: SkillProposal | null;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const BRANCHES = new Set<MemoryBranchKind>(['long-term', 'project', 'experience']);
const SCOPES = new Set<MemoryScope>(['global', 'workspace', 'project']);
const INTENTS = new Set<LlmMemoryIntentKind>(['read', 'write', 'merge', 'invalidate', 'conflict', 'none']);

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

function validateSkillProposal(proposal: SkillProposal | null | undefined): {
  name: string; description: string; whenToUse?: string; body: string;
} | null {
  if (!proposal || typeof proposal !== 'object') return null;
  const name = cleanString(proposal.name, 64) ?? '';
  const description = cleanString(proposal.description, 200) ?? '';
  const body = cleanString(proposal.body, 12_000) ?? '';
  const whenToUse = cleanString(proposal.whenToUse, 500);
  if (!name || !description || !body || !NAME_RE.test(name)) return null;
  return { name, description, whenToUse, body };
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
    if (policy === 'never' || (policy === 'adaptive' && !hasReusableEvolutionSignal(ctx))) {
      ctx.evolutionNotes = [];
      return {
        stage: 'evolve',
        next: 'capture',
        ok: true,
        meta: { skippedModelCall: true, reason: policy === 'never' ? 'disabled' : 'no-reusable-signal' },
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
        onRequest: (request) => prepareModelRequest(
          ctx,
          'evolve',
          request,
          buildRunRequestCandidates(ctx, 'evolve', request.messages, {
            history: [],
            primaryUserKind: 'workflow_state',
          }),
        ),
        onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
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
    ctx.evolutionNotes = records
      .filter((record) => record.decision === 'committed' && record.summary)
      .map((record) => record.summary!)
      .concat(legacyNotes);

    let skillCreated: string | null = null;
    const proposal = validateSkillProposal(parsed?.createSkill);
    if (deps.createSkill && proposal && ctx.verificationHistory?.at(-1)?.verdict === 'pass') {
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
        legacyNotesIgnored: legacyNotes.length,
        skillCreated,
      },
    };
  };
}

function hasReusableEvolutionSignal(ctx: RunContext): boolean {
  if (ctx.verificationHistory?.at(-1)?.verdict !== 'pass') return false;
  const inbound = textOf(ctx.inbound);
  if (/(?:记住|以后|始终|偏好|习惯|规则|约定|remember|always|prefer|preference|convention)/iu.test(inbound)) {
    return true;
  }
  if (ctx.taskBook?.complexity === 'complex' || ctx.taskBook?.complexity === 'standard') return true;
  if ((ctx.recoveryAttempts ?? 0) > 0 || (ctx.replanAttempts ?? 0) > 0) return true;
  const durableTools = new Set(['write', 'edit', 'exec', 'create_skill']);
  return ctx.produced.some((message) => message.content.some((block) => (
    block.type === 'tool_calls' && block.calls.some((call) => durableTools.has(call.name))
  )));
}
