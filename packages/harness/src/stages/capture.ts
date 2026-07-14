// @littlesheep/harness - CAPTURE records detailed run facts in the daily branch.

import type { RunContext, StageResult } from '@littlesheep/types';
import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import {
  InjectionTier,
  type MemoryWriteIntent,
  type MemoryWriteServiceLike,
} from '@littlesheep/memory-tree';
import { textOf, callLlmForJson, asStringArray } from './_shared.js';
import { prepareModelRequest, recordProviderUsage } from '../model-observability.js';
import { buildRunRequestCandidates } from '../context-candidates.js';

export interface CaptureStageDeps {
  llm: LlmClient;
  model: string;
  memoryWriter?: MemoryWriteServiceLike;
}

const SYSTEM_PROMPT = `You are the CAPTURE stage of a hard-control-flow agent.
Record factual run details that may help later reconstruction. This is the daily
timeline, not long-term memory and not a skill library.

Return ONLY JSON:
{"observations":[{
  "summary":"short dated index title",
  "content":"specific fact, action, result or unresolved issue",
  "retrievalKeys":["concrete","search","keys"],
  "importance":0.0,
  "confidence":0.0,
  "reason":"why this detail may matter later"
}]}

Do not record greetings, generic reply wording, transient emotion, guesses,
secrets, or a duplicate paraphrase of the final answer. Return an empty array
when nothing factual happened.`;

interface Observation {
  summary?: unknown;
  content?: unknown;
  retrievalKeys?: unknown;
  importance?: unknown;
  confidence?: unknown;
  reason?: unknown;
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

function intentsFrom(parsed: DecodedCapture | null, ctx: RunContext): MemoryWriteIntent[] {
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
  const result: MemoryWriteIntent[] = [];
  for (const observation of observations) {
    const summary = text(observation.summary, 240);
    const content = text(observation.content, 4_000);
    const reason = text(observation.reason, 500);
    if (!summary || !content || !reason) continue;
    const retrievalKeys = keys(observation.retrievalKeys, `${summary} ${content}`);
    if (retrievalKeys.length === 0) continue;
    result.push({
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
      importance: score(observation.importance, 0.4),
      confidence: score(observation.confidence, 0.6),
      reason,
    });
  }
  return result;
}

export function createCaptureStage(deps: CaptureStageDeps) {
  return async function captureStage(ctx: RunContext): Promise<StageResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
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
    const intents = intentsFrom(parsed, ctx);
    ctx.insights = intents.map((intent) => intent.summary);
    const writeResults = deps.memoryWriter ? await deps.memoryWriter.writeMany(intents) : [];
    return {
      stage: 'capture',
      next: 'finalize',
      ok: true,
      meta: {
        proposedObservations: intents.length,
        memoryWrites: writeResults.map((result) => ({ decision: result.decision, nodeId: result.node?.id, reason: result.reason })),
      },
    };
  };
}
