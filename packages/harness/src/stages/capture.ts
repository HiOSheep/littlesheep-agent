// @littlesheep/harness - CAPTURE records detailed run facts in the daily branch.

import type { LlmMemoryIntentKind, RunContext, StageResult } from '@littlesheep/types';
import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import {
  InjectionTier,
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
import { CAPTURE_MEMORY_PROMPT } from './memory-stage-prompts.js';
import { writeMemoryState } from '../memory-state.js';

export interface CaptureStageDeps {
  llm: LlmClient;
  model: string;
  memoryWriter?: MemoryWriteServiceLike;
  llmEnabled?: boolean;
}

interface Observation {
  intent?: unknown;
  summary?: unknown;
  content?: unknown;
  retrievalKeys?: unknown;
  importance?: unknown;
  confidence?: unknown;
  reason?: unknown;
  epistemic?: unknown;
}

interface DecodedCapture {
  observations?: unknown;
  /** Backward-compatible mock shape; converted only into daily records. */
  insights?: unknown;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function score(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function keys(value: unknown, fallback: string): string[] {
  const provided = Array.isArray(value)
    ? value.map((entry) => text(entry, 80)).filter((entry): entry is string => !!entry)
    : [];
  if (provided.length > 0) return [...new Set(provided)].slice(0, 16);
  return [...new Set(fallback.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((entry) => entry.length > 2))].slice(0, 8);
}

function proposalsFrom(
  parsed: DecodedCapture | null,
  ctx: RunContext,
  proposalSource: 'model' | 'runtime' = 'model',
): GatedMemoryProposal[] {
  const observations: Observation[] = Array.isArray(parsed?.observations)
    ? parsed!.observations!.filter((entry): entry is Observation => !!entry && typeof entry === 'object').slice(0, 10)
    : asStringArray(parsed?.insights).slice(0, 10).map((insight) => ({
        summary: insight.slice(0, 120),
        content: insight,
        retrievalKeys: keys(undefined, insight),
        importance: 0.4,
        confidence: 0.6,
        reason: 'Legacy CAPTURE observation retained only in the daily timeline.',
      }));
  const result: GatedMemoryProposal[] = [];
  for (const [index, observation] of observations.entries()) {
    const rawIntent = text(observation.intent, 24) as LlmMemoryIntentKind | undefined;
    const intent: LlmMemoryIntentKind = rawIntent ?? 'write';
    const summary = text(observation.summary, 240);
    const content = text(observation.content, 4_000);
    const reason = text(observation.reason, 500);
    const importance = score(observation.importance, 0.4);
    const confidence = score(observation.confidence, 0.6);
    const gated = evaluateMemoryIntent({
      ctx,
      stage: 'capture',
      intent,
      branch: 'daily',
      summary,
      importance,
      confidence,
      minConfidence: 0.5,
      proposalSource,
    });
    if (gated.action !== 'commit') {
      result.push(gated);
      continue;
    }
    if (!summary || !content || !reason) {
      result.push({
        ...gated,
        action: 'reject',
        reason: 'A CAPTURE write must include summary, content, and reason.',
      });
      continue;
    }
    const retrievalKeys = keys(observation.retrievalKeys, `${summary} ${content}`);
    if (retrievalKeys.length === 0) {
      result.push({ ...gated, action: 'reject', reason: 'A CAPTURE write requires retrieval keys.' });
      continue;
    }
    const writeIntent: MemoryWriteIntent = {
      id: `${ctx.runId}:capture:memory-intent:${index + 1}`,
      branch: 'daily',
      parentNodeId: 'daily:root',
      scope: 'workspace',
      scopeKey: ctx.cwd,
      tier: InjectionTier.T3_DETAIL,
      summary,
      content,
      retrievalKeys,
      sourceRunId: ctx.runId,
      sourceStage: 'capture',
      sourceRefs: memoryWriteSourceRefs(gated),
      evidenceRefs: memoryWriteEvidenceRefs(gated),
      importance,
      confidence,
      reason,
      epistemic: resolveMemoryWriteEpistemic({
        raw: observation.epistemic,
        stage: 'capture',
        branch: 'daily',
        scope: 'workspace',
        scopeKey: ctx.cwd,
        sourceRefs: gated.sourceRefs,
        evidenceRefs: gated.evidenceRefs,
      }),
    };
    result.push({ ...gated, writeIntent });
  }
  return result;
}

export function createCaptureStage(deps: CaptureStageDeps) {
  return async function captureStage(ctx: RunContext): Promise<StageResult> {
    if (deps.llmEnabled === false) {
      const proposals = proposalsFrom(deterministicCapture(ctx), ctx, 'runtime');
      const { records, writeResults } = await commitMemoryIntentBatch(
        ctx,
        'capture',
        deps.memoryWriter,
        proposals,
      );
      writeMemoryState(ctx, 'capture', {
        insights: records
          .filter((record) => record.decision === 'committed' && record.summary)
          .map((record) => record.summary!),
      });
      return {
        stage: 'capture',
        next: 'finalize',
        ok: true,
        meta: {
          skippedModelCall: true,
          sourceCapture: 'runner-deterministic-conversation-records',
          memoryWrites: writeResults.map((result) => ({
            decision: result.decision,
            nodeId: result.node?.id,
            reason: result.reason,
          })),
        },
      };
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: CAPTURE_MEMORY_PROMPT },
      {
        role: 'user',
        content: [
          `Workspace: ${ctx.cwd}`,
          `Inbound: ${textOf(ctx.inbound).slice(0, 800)}`,
          `Task status: ${ctx.taskExecution?.status ?? 'chat/no-task'}`,
          `Reply: ${(ctx.reply ?? '').slice(0, 1_000)}`,
          `Tools used: ${(ctx.toolResults ?? []).length}`,
        ].join('\n'),
      },
    ];
    let parsed: DecodedCapture | null = null;
    try {
      ({ parsed } = await callLlmForJson<DecodedCapture>(deps.llm, deps.model, messages, {
        maxAttempts: 2,
        maxTokens: 900,
        signal: ctx.signal,
        onRequest: (request) => prepareModelRequest(
          ctx,
          'capture',
          request,
          buildRunRequestCandidates(ctx, 'capture', request.messages, {
            history: [],
            primaryUserKind: 'workflow_state',
          }),
        ),
        onResponse: (request, response) => recordProviderUsage(ctx, request, response.usage),
      }));
    } catch {
      // Capture is useful but non-blocking for the completed user task.
    }
    const proposals = proposalsFrom(parsed, ctx);
    const { records, writeResults } = await commitMemoryIntentBatch(
      ctx,
      'capture',
      deps.memoryWriter,
      proposals,
    );
    writeMemoryState(ctx, 'capture', {
      insights: records
        .filter((record) => record.decision === 'committed' && record.summary)
        .map((record) => record.summary!),
    });
    return {
      stage: 'capture',
      next: 'finalize',
      ok: true,
      meta: {
        proposedObservations: proposals.length,
        memoryWrites: writeResults.map((result) => ({ decision: result.decision, nodeId: result.node?.id, reason: result.reason })),
        memoryIntentDecisions: records.map((record) => ({
          intent: record.proposedIntent,
          decision: record.decision,
          reason: record.reason,
        })),
      },
    };
  };
}

function deterministicCapture(ctx: RunContext): DecodedCapture {
  const inbound = textOf(ctx.inbound).trim();
  const goal = ctx.taskBook?.goal?.trim() || inbound || 'Conversation run';
  const reply = (ctx.reply ?? '').trim();
  const execution = ctx.taskExecution;
  const status = execution?.status ?? (ctx.lastError ? 'error' : 'completed');
  const content = [
    `User request: ${inbound || '(empty)'}`,
    `Run status: ${status}`,
    execution ? `Task goal: ${execution.goal}` : undefined,
    reply ? `Delivered result: ${reply}` : undefined,
    `Tool calls: ${(ctx.toolResults ?? []).length}`,
  ].filter((line): line is string => !!line).join('\n').slice(0, 4_000);
  return {
    observations: [{
      intent: 'write',
      summary: `Run ${status}: ${goal}`.slice(0, 240),
      content,
      retrievalKeys: keys(undefined, `${goal} ${inbound}`),
      importance: execution ? 0.5 : 0.35,
      confidence: 1,
      reason: 'Deterministic runtime record derived from persisted conversation and execution state.',
    }],
  };
}
