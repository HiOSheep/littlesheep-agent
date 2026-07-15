import { describe, expect, it, vi } from 'vitest';
import type { MemoryWriteIntent, MemoryWriteServiceLike } from '@littlesheep/memory-tree';
import { createEvolveStage } from './evolve.js';
import { createCaptureStage } from './capture.js';
import { createMockLlm, makeCtx, textResponse } from '../tests/helpers.js';

function writer(): MemoryWriteServiceLike & { writeMany: ReturnType<typeof vi.fn> } {
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
  return { write: vi.fn(), writeMany } as unknown as MemoryWriteServiceLike & { writeMany: ReturnType<typeof vi.fn> };
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

describe('EVOLVE structured memory intents', () => {
  it('routes durable proposals through the indexed writer with run provenance', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{
        intent: 'write',
        branch: 'project',
        parentNodeId: 'project:root',
        scope: 'workspace',
        summary: 'Workspace uses pnpm',
        content: 'Use pnpm workspace commands for this repository.',
        retrievalKeys: ['pnpm', 'workspace'],
        importance: 0.8,
        confidence: 0.95,
        reason: 'Verified from packageManager and successful commands.',
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();
    const result = await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(result.next).toBe('capture');
    expect(memoryWriter.writeMany).toHaveBeenCalledTimes(1);
    const [intent] = memoryWriter.writeMany.mock.calls[0]![0] as MemoryWriteIntent[];
    expect(intent).toMatchObject({
      branch: 'project', parentNodeId: 'project:root', scope: 'workspace', scopeKey: ctx.cwd,
      sourceRunId: ctx.runId, sourceStage: 'evolve', summary: 'Workspace uses pnpm',
    });
    expect(intent.sourceRefs).toEqual(expect.arrayContaining([
      expect.stringContaining(':verification:1:pass'),
      expect.stringContaining(':step:step-1:done'),
      expect.stringContaining(':tool:tool-1:succeeded'),
    ]));
    expect(ctx.evolutionNotes).toEqual(['Workspace uses pnpm']);
    expect(ctx.memoryIntentDecisions).toEqual([
      expect.objectContaining({ proposedIntent: 'write', decision: 'committed' }),
    ]);
    expect(ctx.modelRequests?.map((request) => request.stage)).toEqual(['evolve']);
  });

  it('does not write legacy free-form notes that bypass the structured gate', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse('{"notes":["temporary maybe"]}'));
    const ctx = makeCtx();
    const result = await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);
    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
    expect(result.meta?.legacyNotesIgnored).toBe(1);
  });

  it('defers invalidate/conflict proposals without mutating memory', async () => {
    const memoryWriter = writer();
    const llm = createMockLlm(textResponse(JSON.stringify({
      memories: [{
        intent: 'conflict',
        branch: 'project',
        summary: 'Package manager rule conflicts',
        reason: 'Two verified sources disagree.',
      }],
      createSkill: null,
    })));
    const ctx = verifiedCtx();

    await createEvolveStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(memoryWriter.writeMany).toHaveBeenCalledWith([]);
    expect(ctx.memoryIntentDecisions).toEqual([
      expect.objectContaining({ proposedIntent: 'conflict', decision: 'deferred' }),
    ]);
  });
});

describe('CAPTURE daily timeline intents', () => {
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
    }] })));
    const ctx = verifiedCtx('Build passed');
    const result = await createCaptureStage({ llm, model: 'test', memoryWriter })(ctx);

    expect(result.next).toBe('finalize');
    const [intent] = memoryWriter.writeMany.mock.calls[0]![0] as MemoryWriteIntent[];
    expect(intent).toMatchObject({
      branch: 'daily', parentNodeId: 'daily:root', scope: 'workspace', scopeKey: ctx.cwd,
      sourceRunId: ctx.runId, sourceStage: 'capture', summary: 'Build verification',
    });
    expect(intent?.tier).toBe(3);
    expect(intent?.sourceRefs).toEqual(expect.arrayContaining([
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
