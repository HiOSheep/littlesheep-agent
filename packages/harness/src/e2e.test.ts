// @littlesheep/harness — e2e.test.ts
// End-to-end agent loop: real stages + mock infrastructure.
// Validates the full Core Flow state machine through every branch.
import { describe, it, expect } from 'vitest';
import { createDefaultHarness } from './default-harness.js';
import {
  createMockLlm,
  textResponse,
  makeCtx,
  createMockSessionManager,
  createMockMemoryStore,
  makeTool,
  toolCallResponse,
} from './tests/helpers.js';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { textMessage, type ToolStreamEvent } from '@littlesheep/types';

function makeHarness(llm: ReturnType<typeof createMockLlm>) {
  return createDefaultHarness({
    model: 'test',
    config: DEFAULT_CONFIG,
    branding: DEFAULT_BRANDING,
    llm,
    sessionManager: createMockSessionManager(),
    memoryStore: createMockMemoryStore(),
  });
}

describe('e2e agent loop', () => {
  it('chat: "hello" → rules-classify(chat) → reply → finalize', async () => {
    // 'hello' hits the greeting rule (confidence 0.9) → classify skips LLM.
    // Only reply stage consumes one LLM call.
    const llm = createMockLlm(textResponse('Hello! How can I help?'));
    const h = makeHarness(llm);
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });
    const res = await h.run(ctx);
    expect(res.ok).toBe(true);
    expect(res.next).toBe('exit');
    expect(ctx.reply).toBe('Hello! How can I help?');
    expect(ctx.produced.length).toBeGreaterThanOrEqual(1);
    expect(ctx.produced[ctx.produced.length - 1].role).toBe('assistant');
    const trace = res.meta?.trace as Array<{ name: string }>;
    expect(trace.map((t) => t.name)).toEqual(['enter', 'classify', 'reply', 'finalize']);
  });

  it('capability-question regression keeps Runtime progress out of the chat reply', async () => {
    const llm = createMockLlm(textResponse('当前只根据 Runtime 能力快照回答，尚未执行网络查询。'));
    const h = makeHarness(llm);
    const durableTypes: string[] = [];
    const snapshot = {
      version: 1 as const,
      epoch: 'capability-epoch-1',
      generatedAt: '2026-09-02T00:00:00.000Z',
      permissionPolicyId: 'research' as const,
      workspace: 'available' as const,
      tools: [],
      network: { enabled: false, status: 'disabled' as const },
    };
    const ctx = makeCtx({
      inbound: textMessage('user', '你能调用网络了吗？'),
      appendDurableEvent: async (event) => { durableTypes.push(event.type); },
    });
    ctx.capabilitySnapshot = snapshot;
    const events: ToolStreamEvent[] = [];
    ctx.onToolEvent = (event) => events.push(event);

    const result = await h.run(ctx);

    expect(result.ok, result.error).toBe(true);
    expect(result.next).toBe('exit');
    expect(ctx.produced).toHaveLength(1);
    expect(ctx.produced[0]?.content).toEqual([{ type: 'text', text: '当前只根据 Runtime 能力快照回答，尚未执行网络查询。' }]);
    expect(ctx.replyProvenance?.purpose).toBe('capability_reply');
    expect(ctx.modelRequests?.[0]?.callContract?.purpose).toBe('capability_reply');
    expect(events.filter((event) => event.type === 'model_activity').map((event) => event.activityStatus))
      .toEqual(['running', 'done']);
    expect(events.filter((event) => event.type === 'capability_snapshot' || event.type === 'capability_probe')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'reasoning').every((event) => event.visibility === 'silent')).toBe(true);
    expect(durableTypes.slice(0, 2)).toEqual(['capability_snapshot_read', 'route_decided']);
    expect(durableTypes.slice(-5)).toEqual([
      'model_request_started',
      'model_response_received',
      'model_request_settled',
      'final_reply_proposed',
      'final_reply_settled',
    ]);
  });

  it('problem: no rule matches → one main loop through verify/evolve/capture', async () => {
    // 'solve P vs NP' matches no rule and is not provably complex, so it runs in
    // the single main loop: the model answers directly and no routing, planning
    // or final-reply request is spent.
    const llm = createMockLlm([
      textResponse('final assembled answer'),
      textResponse('{"notes":[]}'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({ inbound: textMessage('user', 'solve P vs NP') });
    const events: ToolStreamEvent[] = [];
    const deltas: string[] = [];
    const replacements: string[] = [];
    ctx.onToolEvent = (event) => events.push(event);
    ctx.onAssistantDelta = (delta) => deltas.push(delta);
    ctx.onAssistantReplace = (text) => replacements.push(text);
    const res = await h.run(ctx);
    expect(res.ok).toBe(true);
    expect(res.next).toBe('exit');
    const trace = res.meta?.trace as Array<{ name: string }>;
    expect(trace.map((t) => t.name)).toEqual([
      'enter', 'classify', 'execute', 'verify', 'evolve', 'capture', 'finalize',
    ]);
    const businessEvents = events.filter((event) => event.type !== 'reasoning' && event.type !== 'model_activity');
    // No TaskBook: the work never left the main loop.
    expect(businessEvents.map((event) => event.type)).toEqual([
      'verification_start',
      'verification',
    ]);
    expect(events.filter((event) => event.type === 'reasoning')).toEqual([]);
    expect(events.filter((event) => event.type === 'model_activity').map((event) => event.activityStatus))
      .toEqual(ctx.modelRequests!.flatMap(() => ['running', 'done']));
    expect(events.filter((event) => event.type === 'model_activity').every((event) => event.stage === undefined)).toBe(true);
    expect(deltas).toEqual([]);
    expect(replacements).toEqual([]);
    expect(ctx.finalReplySettlement?.status).toBe('settled');
    expect(ctx.produced.at(-1)?.finalReplySettlement?.settlementId).toBe(ctx.finalReplySettlement?.settlementId);
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_tool_loop',
    ]);
    for (const request of ctx.modelRequests ?? []) {
      const contract = request.callContract;
      const context = ctx.contextSnapshots?.find((snapshot) => snapshot.id === request.contextSnapshotId);
      expect(contract).toBeDefined();
      expect(context).toBeDefined();
      expect(context?.items.every((item) => contract!.inputs.allowedContextKinds.includes(item.kind))).toBe(true);
    }
    // Neither VERIFY nor DECIDE spends a model request any more.
    expect(ctx.modelRequests?.some((request) => request.callContract?.purpose === 'verify')).toBe(false);
    expect(ctx.modelRequests?.some((request) => request.callContract?.purpose === 'decide')).toBe(false);
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ verdict: 'unverified', source: 'structural' });
    expect(new Set(ctx.modelRequests?.map((request) => request.callContract)).size).toBe(ctx.modelRequests?.length);
  });

  it('retracts a draft built on incomplete step evidence before the replan answer is published', async () => {
    const read = makeTool('read', { ok: true, output: 'unused' });
    let toolExecutions = 0;
    read.execute = async () => {
      toolExecutions += 1;
      return toolExecutions === 1
        ? { callId: '', ok: false, error: 'ENOENT: file not found' }
        : { callId: '', ok: true, output: 'correct file contents' };
    };
    const initialTaskBook = {
      assessment: {
        userNeed: 'prepare a verified summary', complexity: 'standard', goal: 'prepare a verified summary',
        successCriteria: ['summary is verified'], requiresTaskBook: true, maxExtraScopeRatio: 1.5,
      },
      taskBook: {
        goal: 'prepare a verified summary', complexity: 'standard', successCriteria: ['summary is verified'],
        steps: [
          { id: 'outline', description: 'prepare the outline' },
          { id: 'summary', description: 'read the file and prepare the summary', tools: ['read'] },
        ],
      },
    };
    const revisedTaskBook = {
      ...initialTaskBook,
      taskBook: {
        ...initialTaskBook.taskBook,
        steps: [
          { id: 'outline', description: 'keep the completed outline' },
          { id: 'summary', description: 'read the corrected path and prepare the summary', tools: ['read'] },
        ],
      },
    };
    const llm = createMockLlm([
      textResponse('{"type":"problem","confidence":0.9,"reason":"task"}'),
      textResponse(JSON.stringify(initialTaskBook)),
      textResponse('outline evidence'),
      toolCallResponse([{ id: 'read-1', name: 'read', args: { path: 'missing.txt' } }]),
      textResponse('unverified draft from the failed read'),
      textResponse(JSON.stringify(revisedTaskBook)),
      toolCallResponse([{ id: 'read-2', name: 'read', args: { path: 'correct.txt' } }]),
      textResponse('summary from the correct file'),
      textResponse('verified final answer'),
      textResponse('{"notes":[]}'),
      textResponse('{"insights":[]}'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      // A provably multi-step request keeps this on the TaskBook path, which is
      // where step-scoped partial replanning still lives.
      inbound: textMessage('user', 'prepare a verified summary as a multi-step job'),
      tools: [read],
    });
    const events: ToolStreamEvent[] = [];
    const deltas: string[] = [];
    const replacements: string[] = [];
    ctx.onToolEvent = (event) => events.push(event);
    ctx.onAssistantDelta = (delta) => deltas.push(delta);
    ctx.onAssistantReplace = (text) => replacements.push(text);

    const res = await h.run(ctx);

    expect(res.ok).toBe(true);
    expect(toolExecutions).toBe(2);
    // The draft produced while the recorded step evidence was incomplete is
    // retracted: only the post-replan answer is settled and persisted.
    expect(ctx.reply).toBe('verified final answer');
    expect(replacements).toContain('');
    expect(ctx.finalReplySettlement?.status).toBe('settled');
    expect(ctx.produced.some((message) => JSON.stringify(message.content).includes('unverified draft'))).toBe(false);
    expect(events.filter((event) => event.type === 'final_delta')).toHaveLength(0);
    expect(events.filter((event) => event.type !== 'reasoning' && event.type !== 'model_activity').map((event) => event.type)).toEqual([
      'task_book', 'step_start', 'step_done',
      'step_start', 'tool_start', 'tool_end', 'step_failed',
      'verification_start', 'verification',
      'task_book', 'step_skipped', 'step_start', 'tool_start', 'tool_end', 'step_done',
      'verification_start', 'verification',
    ]);
  });

  it('unmatched: no rule matches → the main loop answers → verify → finalize', async () => {
    // 'xyzzy' matches no rule, so the main loop handles it: the model's own text
    // is published and no clarification checkpoint is created.
    const llm = createMockLlm([
      textResponse('Could you clarify what you want?'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({ inbound: textMessage('user', 'xyzzy') });
    const res = await h.run(ctx);
    expect(res.ok).toBe(true);
    expect(ctx.reply).toBe('Could you clarify what you want?');
    const trace = res.meta?.trace as Array<{ name: string }>;
    expect(trace.map((t) => t.name)).toEqual([
      'enter', 'classify', 'execute', 'verify', 'evolve', 'capture', 'finalize',
    ]);
    expect(ctx.clarificationRequest).toBeUndefined();
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_tool_loop',
    ]);
  });

  it('partially replans a failed step without rerunning completed work', async () => {
    const read = makeTool('read', { ok: true, output: 'unused' });
    let toolExecutions = 0;
    read.execute = async () => {
      toolExecutions += 1;
      return toolExecutions === 1
        ? { callId: '', ok: false, error: 'ENOENT: file not found' }
        : { callId: '', ok: true, output: 'correct file contents' };
    };
    const initialTaskBook = {
      assessment: {
        userNeed: 'prepare a summary', complexity: 'standard', goal: 'prepare the summary',
        successCriteria: ['summary is complete'], requiresTaskBook: true, maxExtraScopeRatio: 1.5,
      },
      taskBook: {
        goal: 'prepare the summary', complexity: 'standard', successCriteria: ['summary is complete'],
        steps: [
          { id: 'step-1', description: 'prepare the outline' },
          { id: 'step-2', description: 'read the file and write the summary', tools: ['read'] },
        ],
      },
    };
    const revisedTaskBook = {
      ...initialTaskBook,
      taskBook: {
        ...initialTaskBook.taskBook,
        steps: [
          { id: 'step-1', description: 'do not replace completed outline' },
          { id: 'step-2', description: 'locate the corrected path, read it, and write the summary', tools: ['read'] },
        ],
      },
    };
    const llm = createMockLlm([
      textResponse('{"type":"problem","confidence":0.9,"reason":"multi-step task"}'),
      textResponse(JSON.stringify(initialTaskBook)),
      textResponse('outline evidence'),
      toolCallResponse([{ id: 'read-1', name: 'read', args: { path: 'missing.txt' } }]),
      textResponse('could not read the file'),
      textResponse(JSON.stringify({
        verdict: 'needs_replan', reason: 'path is wrong', feedback: 'use the corrected path',
        failedStepIds: ['step-2'],
      })),
      textResponse(JSON.stringify(revisedTaskBook)),
      toolCallResponse([{ id: 'read-2', name: 'read', args: { path: 'correct.txt' } }]),
      textResponse('summary from the correct file'),
      textResponse('final summary'),
      textResponse('{"verdict":"pass","reason":"summary is complete"}'),
      textResponse('{"notes":[]}'),
      textResponse('{"insights":[]}'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      // Multi-step scope keeps the TaskBook path, where step-scoped replan lives.
      inbound: textMessage('user', 'prepare a summary from the file as a multi-step job'),
      tools: [read],
    });

    const res = await h.run(ctx);

    expect(res.ok).toBe(true);
    expect(toolExecutions).toBe(2);
    expect(ctx.taskExecution?.steps[0]).toMatchObject({
      stepId: 'step-1', description: 'prepare the outline', output: 'outline evidence', attempt: 1,
    });
    expect(ctx.taskExecution?.steps[1]).toMatchObject({
      stepId: 'step-2', status: 'done', attempt: 2,
    });
    expect(ctx.replanHistory?.[0]).toMatchObject({
      targetStepIds: ['step-2'], preservedStepIds: ['step-1'], revisedStepIds: ['step-2'],
    });
    const trace = res.meta?.trace as Array<{ name: string }>;
    expect(trace.map((item) => item.name)).toEqual([
      'enter', 'classify', 'decide', 'execute', 'verify',
      'decide', 'execute', 'verify', 'evolve', 'capture', 'finalize',
    ]);
  });
});
