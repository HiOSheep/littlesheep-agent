import { describe, expect, it, vi } from 'vitest';
import type {
  MemoryAtomHierarchyServiceLike,
  MemoryAtomReconciliationServiceLike,
  MemoryAtomRevisionServiceLike,
  MemoryWriteIntent,
  MemoryWriteServiceLike,
} from '@littlesheep/memory-tree';
import { textMessage, type RuntimeKnownStateMemoryReference } from '@littlesheep/types';
import { createCaptureStage } from './capture.js';
import { createMockLlm, makeCtx, textResponse } from '../tests/helpers.js';

function writer(): MemoryWriteServiceLike & {
  writeMany: ReturnType<typeof vi.fn>;
  captureConversationSources: ReturnType<typeof vi.fn>;
} {
  const writeMany = vi.fn(async (intents: MemoryWriteIntent[]) => intents.map((intent, index) => ({
    intentId: intent.id ?? `intent-${index}`,
    decision: 'created' as const,
    reason: 'created',
    node: {
      id: `node-${index}`,
      branch: intent.branch,
      parentNodeId: intent.parentNodeId,
      childIds: [],
      scope: intent.scope,
      scopeKey: intent.scopeKey,
      tier: intent.tier,
      summary: intent.summary,
      content: intent.content,
      retrievalKeys: intent.retrievalKeys,
      importance: intent.importance,
      confidence: intent.confidence,
      reason: intent.reason,
      sourceRunIds: [intent.sourceRunId],
      sourceStages: [intent.sourceStage],
      status: 'active' as const,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
    },
  })));
  const captureConversationSources = vi.fn(async () => []);
  return { write: vi.fn(), writeMany, captureConversationSources } as unknown as MemoryWriteServiceLike & {
    writeMany: ReturnType<typeof vi.fn>;
    captureConversationSources: ReturnType<typeof vi.fn>;
  };
}

function verifiedCtx(reply = 'Done') {
  const ctx = makeCtx({ reply });
  ctx.taskExecution = {
    goal: 'verify memory gating',
    complexity: 'simple',
    status: 'done',
    startedAt: '2026-07-10T00:00:00.000Z',
    endedAt: '2026-07-10T00:00:01.000Z',
    steps: [{
      stepId: 'step-1',
      description: 'Run the verified action',
      status: 'done',
      startedAt: '2026-07-10T00:00:00.000Z',
      endedAt: '2026-07-10T00:00:01.000Z',
      toolCallIds: ['tool-1'],
      toolResults: [{ callId: 'tool-1', ok: true, output: 'verified' }],
    }],
  };
  ctx.toolResults = [{ callId: 'tool-1', ok: true, output: 'verified' }];
  ctx.verificationHistory = [{
    attempt: 1,
    verdict: 'pass',
    reason: 'Acceptance criteria passed.',
    verifiedAt: '2026-07-10T00:00:02.000Z',
    source: 'model',
  }];
  return ctx;
}

function attachWebEvidence(ctx: ReturnType<typeof verifiedCtx>) {
  ctx.webEvidence = {
    version: 1,
    providerId: 'fake',
    generatedAt: '2026-08-29T00:00:00.000Z',
    completeness: 'complete',
    citationIds: ['web-run-source'],
    citationCount: 1,
    documentCount: 1,
    cached: false,
    partial: false,
    truncated: false,
    blocked: false,
    stale: false,
  };
  return ctx;
}

describe('CAPTURE daily timeline intents', () => {
  it('does not create a per-run daily atom under compaction-only learning', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({ observations: [] })));
    const result = await createCaptureStage({
      llm, model: 'test', memoryWriter, automaticEnabled: false, llmEnabled: true,
    })(verifiedCtx());

    expect(result.meta).toMatchObject({ skippedAutomaticCapture: true, reason: 'compaction-only-memory-policy' });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(memoryWriter.writeMany).not.toHaveBeenCalled();
  });

  it('does not auto-capture a Web-backed run when the user did not request persistence', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({ observations: [{
      intent: 'write', summary: 'Web lookup', content: 'Fetched page text.',
      retrievalKeys: ['web', 'lookup'], importance: 0.8, confidence: 0.9,
      reason: 'Record the lookup.',
    }] })));
    const ctx = attachWebEvidence(verifiedCtx());

    await createCaptureStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
    expect(ctx.memoryIntentDecisions).toEqual([
      expect.objectContaining({ decision: 'rejected' }),
    ]);
  });

  it('forces observations into the daily workspace branch regardless of model wording', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({ observations: [{
      intent: 'write',
      summary: 'Build verification',
      content: 'The production build completed successfully.',
      retrievalKeys: ['build', 'verification'],
      importance: 0.5,
      confidence: 0.9,
      reason: 'Useful when diagnosing the next build regression.',
      epistemic: {
        domain: 'task',
        statementKind: 'reported-observation',
        assertedBy: { kind: 'tool', id: 'build-command' },
      },
    }] })));
    const ctx = verifiedCtx('Build passed');
    const result = await createCaptureStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(result.next).toBe('finalize');
    const [intent] = memoryWriter.writeMany.mock.calls[0]![0] as MemoryWriteIntent[];
    expect(intent).toMatchObject({
      branch: 'daily', parentNodeId: 'daily:root', scope: 'workspace', scopeKey: ctx.cwd,
      sourceRunId: ctx.runId, sourceStage: 'capture', summary: 'Build verification',
      epistemic: {
        domain: 'task',
        statementKind: 'reported-observation',
        epistemicStatus: 'corroborated',
        authorityScope: { kind: 'tool-evidence', scope: 'workspace', scopeKey: ctx.cwd },
        assertedBy: { kind: 'tool', id: 'build-command' },
      },
    });
    expect(intent?.tier).toBe(3);
    expect(intent?.sourceRefs).toEqual(expect.arrayContaining([
      expect.stringContaining(':user-message:'),
      expect.stringContaining(':verification:1'),
    ]));
    expect(intent?.evidenceRefs).toEqual(expect.arrayContaining([
      expect.stringContaining(':verification:1:pass'),
    ]));
    expect(ctx.modelRequests?.map((request) => request.stage)).toEqual(['capture']);
  });

  it('keeps a model transport failure non-fatal and performs no write', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(''));
    llm.chat.mockRejectedValue(new Error('offline'));
    const result = await createCaptureStage({ llm, model: 'test', memoryWriter })(makeCtx());
    expect(result.ok).toBe(true);
    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
  });
});
