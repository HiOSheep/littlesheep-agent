// @littlesheep/harness - EVOLVE proposes structured durable memories/skills.

import type { RunContext, StageResult } from '@littlesheep/types';
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
}

const SYSTEM_PROMPT = `You are the EVOLVE stage of a hard-control-flow agent.
Separate durable capability from run narration. Propose only memories that will
materially improve future work; CAPTURE records ordinary run details elsewhere.

Memory tree branches and canonical parent roots:
- long-term -> long-term:root: explicit stable user preferences, cross-project facts, durable decisions.
- project -> project:root: workspace-specific architecture, rules, paths and decisions.
- experience -> experience:root: verified reusable methods, pitfalls and tool-use patterns.

Return ONLY JSON:
{
  "memories": [{
    "branch": "long-term|project|experience",
    "parentNodeId": "branch:root",
    "scope": "global|workspace|project",
    "summary": "short index title",
    "content": "the durable fact or reusable lesson",
    "retrievalKeys": ["specific", "search", "keys"],
    "importance": 0.0,
    "confidence": 0.0,
    "reason": "why this should affect future runs"
  }],
  "createSkill": {
    "name": "lowercase-hyphen-name",
    "description": "one-line purpose",
    "whenToUse": "activation condition",
    "body": "# Skill Title\\n\\n## Overview\\n..."
  }
}

Write sparingly. Do not propose:
- temporary state, current mood, one-off output, speculation or facts useful only in this run;
- content already present in the supplied history/reply unless the run verified or materially revised it;
- a long-term memory below 0.75 confidence and 0.70 importance;
- an experience unless the method was actually tested or the failure mechanism is evidenced.

Create a skill only for a recurring, multi-step procedure with clear decision criteria.
If nothing qualifies, return {"memories":[],"createSkill":null}.`;

interface SkillProposal {
  name?: unknown;
  description?: unknown;
  whenToUse?: unknown;
  body?: unknown;
}

interface MemoryProposal {
  branch?: unknown;
  parentNodeId?: unknown;
  scope?: unknown;
  summary?: unknown;
  content?: unknown;
  retrievalKeys?: unknown;
  importance?: unknown;
  confidence?: unknown;
  reason?: unknown;
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

function memoryIntents(value: unknown, ctx: RunContext): MemoryWriteIntent[] {
  if (!Array.isArray(value)) return [];
  const intents: MemoryWriteIntent[] = [];
  for (const raw of value.slice(0, 8)) {
    if (!raw || typeof raw !== 'object') continue;
    const proposal = raw as MemoryProposal;
    const branch = cleanString(proposal.branch, 32) as MemoryBranchKind | undefined;
    if (!branch || !BRANCHES.has(branch)) continue;
    const summary = cleanString(proposal.summary, 240);
    const content = cleanString(proposal.content, 4_000);
    const reason = cleanString(proposal.reason, 500);
    const retrievalKeys = stringArray(proposal.retrievalKeys);
    if (!summary || !content || !reason || retrievalKeys.length === 0) continue;
    const requestedScope = cleanString(proposal.scope, 24) as MemoryScope | undefined;
    const scope: MemoryScope = requestedScope && SCOPES.has(requestedScope)
      ? requestedScope
      : branch === 'project' ? 'workspace' : 'global';
    const scopeKey = scope === 'global' ? undefined : ctx.cwd;
    const requestedParent = cleanString(proposal.parentNodeId, 200);
    intents.push({
      branch,
      parentNodeId: requestedParent ?? `${branch}:root`,
      scope,
      scopeKey,
      tier: InjectionTier.T2_RELEVANT,
      summary,
      content,
      retrievalKeys,
      sourceRunId: ctx.runId,
      sourceStage: 'evolve',
      importance: clampScore(proposal.importance),
      confidence: clampScore(proposal.confidence),
      reason,
    });
  }
  return intents;
}

export function createEvolveStage(deps: EvolveStageDeps) {
  return async function evolveStage(ctx: RunContext): Promise<StageResult> {
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
      { role: 'system', content: SYSTEM_PROMPT },
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

    const intents = memoryIntents(parsed?.memories, ctx);
    const legacyNotes = asStringArray(parsed?.notes);
    ctx.evolutionNotes = intents.map((intent) => intent.summary).concat(legacyNotes);
    const writeResults = deps.memoryWriter ? await deps.memoryWriter.writeMany(intents) : [];

    let skillCreated: string | null = null;
    const proposal = validateSkillProposal(parsed?.createSkill);
    if (deps.createSkill && proposal) {
      try { skillCreated = await deps.createSkill(proposal); } catch { /* non-fatal */ }
    }

    return {
      stage: 'evolve',
      next: 'capture',
      ok: true,
      meta: {
        proposedMemories: intents.length,
        memoryWrites: writeResults.map((result) => ({ decision: result.decision, nodeId: result.node?.id, reason: result.reason })),
        legacyNotesIgnored: legacyNotes.length,
        skillCreated,
      },
    };
  };
}
