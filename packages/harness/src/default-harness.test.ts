// @littlesheep/harness — default-harness.test.ts
// Verifies the Core Flow state machine: hard-coded transitions via switch (D6).
// LLM never chooses the stage; it only decides within a stage.
import { describe, it, expect } from 'vitest';
import { createDefaultHarness } from './default-harness.js';
import { createNextHarness } from './durable-harness.js';
import {
  createMockLlm,
  textResponse,
  toolCallResponse,
  makeCtx,
  makeTool,
  createMockSessionManager,
  createMockMemoryStore,
} from './tests/helpers.js';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import {
  RUNTIME_EVENT_VERSION,
  textMessage,
  type RuntimeEventDecision,
  type RuntimeEventEnvelope,
  type RuntimeEventQueueLike,
} from '@littlesheep/types';

const baseDeps = {
  model: 'test',
  config: DEFAULT_CONFIG,
  branding: DEFAULT_BRANDING,
};

function makeHarness(llm: ReturnType<typeof createMockLlm>) {
  return createDefaultHarness({
    ...baseDeps,
    llm,
    sessionManager: createMockSessionManager(),
    memoryStore: createMockMemoryStore(),
  });
}

describe('createDefaultHarness state machine', () => {
  it('chat path: enter → classify(chat via rules) → reply → finalize → exit', async () => {
    // 'hello' matches the greeting rule (confidence 0.9 ≥ 0.7) → no LLM for classify.
    // Only reply consumes one LLM call.
    const llm = createMockLlm(textResponse('hi there'));
    const h = makeHarness(llm);
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });
    const res = await h.run(ctx);
    expect(res.next).toBe('exit');
    expect(res.ok).toBe(true);
    const trace = res.meta?.trace as Array<{ name: string }>;
    const names = trace.map((t) => t.name);
    expect(names[0]).toBe('enter');
    expect(names).toContain('classify');
    expect(names).toContain('reply');
    expect(names[names.length - 1]).toBe('finalize');
    expect(ctx.reply).toBe('hi there');
    expect(ctx.classification?.type).toBe('chat');
    expect(ctx.classification?.source).toBe('rules');
  });

  it('answers a capability-status question without entering planning or recovery', async () => {
    const llm = createMockLlm(textResponse('当前还没有配置网络查询工具。'));
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', '但是现在好像还没给你配置网络查询功能吧'),
    });

    const result = await h.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.classification).toMatchObject({
      activity: 'respond',
      type: 'chat',
      reason: 'capability or status question',
    });
    expect(ctx.reply).toBe('当前还没有配置网络查询工具。');
    const trace = result.meta?.trace as Array<{ name: string }>;
    expect(trace.map((item) => item.name)).toEqual([
      'enter', 'classify', 'reply', 'finalize',
    ]);
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('handles an exact-response calibration as one direct model call', async () => {
    const llm = createMockLlm(textResponse('LS-PROVIDER-OK-20260730-1610'));
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', 'Provider校准测试 20260730-1610：请只回复 LS-PROVIDER-OK-20260730-1610'),
      history: [
        textMessage('user', '但是现在好像还没给你配置网络查询功能吧'),
      ],
    });

    const result = await h.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.classification).toMatchObject({
      activity: 'respond',
      source: 'rules',
      reason: 'direct response constraint',
    });
    expect(ctx.reply).toBe('LS-PROVIDER-OK-20260730-1610');
    expect((result.meta?.trace as Array<{ name: string }>).map((item) => item.name)).toEqual([
      'enter', 'classify', 'reply', 'finalize',
    ]);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(ctx.modelRequests).toHaveLength(1);
  });

  it('problem path: enter → classify → decide → execute(stop) → verify(pass) → evolve → capture → finalize → exit', async () => {
    const tool = makeTool('read', { ok: true, output: 'data' });
    // 'read the file' doesn't match any rule → LLM classify fallback.
    // LLM queue: classify → decide → execute(stop) → final reply → verify(pass) → evolve → capture
    const llm = createMockLlm([
      textResponse('{"type":"problem","confidence":0.9,"reason":"task"}'),
      textResponse('{"plan":[{"description":"read it","tools":["read"]}]}'),
      textResponse('done', 'stop'),
      textResponse('The file was read successfully.'),
      textResponse('{"verdict":"pass","reason":"goal achieved"}'),
      textResponse('{"notes":["learned"]}'),
      textResponse('{"insights":["captured"]}'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', 'read the file'),
      tools: [tool],
    });
    const res = await h.run(ctx);
    expect(res.next).toBe('exit');
    expect(res.ok).toBe(true);
    const trace = res.meta?.trace as Array<{ name: string }>;
    const names = trace.map((t) => t.name);
    expect(names).toEqual([
      'enter', 'classify', 'decide', 'execute', 'verify', 'evolve', 'capture', 'finalize',
    ]);
    expect(ctx.classification?.type).toBe('problem');
  });

  it('completes an explicit trivial read-only tool task without a DECIDE request', async () => {
    const tool = makeTool('glob', { ok: true, output: 'attachments/' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'glob-trivial', name: 'glob', args: { pattern: '*' } }]),
      textResponse('共有 1 个条目：attachments/'),
      textResponse('{"verdict":"pass","reason":"glob 结果支持回复中的数量和名称"}'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({
      inbound: textMessage('user', '请使用 glob 工具读取当前文件夹，只告诉我顶层条目数量和名称，不要修改任何文件。'),
      tools: [tool],
    });

    const result = await h.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.classification).toMatchObject({
      activity: 'execute',
      source: 'rules',
      reason: 'explicit tool instruction',
    });
    expect(ctx.reply).toBe('共有 1 个条目：attachments/');
    expect(ctx.replyProvenance).toMatchObject({ purpose: 'execute_tool_loop' });
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ source: 'model', verdict: 'pass' });
    expect(llm.chat).toHaveBeenCalledTimes(3);
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_tool_loop', 'execute_tool_loop', 'verify',
    ]);
    expect(llm.chat.mock.calls.slice(0, 2).every((call) => (
      call[0].tools?.map((candidate) => candidate.function.name).join(',') === 'glob,request_task_book'
    ))).toBe(true);
    expect(llm.chat.mock.calls[2]?.[0].tools).toBeUndefined();
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0]?.input).toEqual({ pattern: '*' });
  });

  it('regenerates and verifies a traceable task reply when an interrupted checkpoint points at ask_user', async () => {
    const llm = createMockLlm(textResponse('文件 resume-proof.txt 已核对，内容为 resume-anchor-4812。'));
    const h = makeHarness(llm);
    h.registerStage('verify', async () => ({ stage: 'verify', next: 'evolve', ok: true }));
    h.registerStage('evolve', async () => ({ stage: 'evolve', next: 'capture', ok: true }));
    h.registerStage('capture', async () => ({ stage: 'capture', next: 'finalize', ok: true }));
    const ctx = makeCtx({
      inbound: textMessage('user', '创建并核对 resume-proof.txt。'),
    });
    ctx.entryStage = 'ask_user';
    ctx.resumedFromCheckpointId = 'checkpoint-after-execute';
    ctx.taskBook = {
      goal: '创建并核对 resume-proof.txt',
      complexity: 'standard',
      successCriteria: ['文件内容为 resume-anchor-4812'],
      steps: [{
        id: 'step-1',
        description: '核对文件内容',
        acceptanceCriteria: ['读取内容匹配'],
        status: 'done',
      }],
    };
    ctx.taskExecution = {
      goal: ctx.taskBook.goal,
      complexity: 'standard',
      status: 'failed',
      startedAt: '2026-08-03T00:00:00.000Z',
      endedAt: '2026-08-03T00:00:01.000Z',
      steps: [{
        stepId: 'step-1',
        description: '核对文件内容',
        status: 'done',
        startedAt: '2026-08-03T00:00:00.000Z',
        endedAt: '2026-08-03T00:00:01.000Z',
        acceptanceCriteria: ['读取内容匹配'],
        toolCallIds: ['read-resume-proof'],
        toolResults: [{
          callId: 'read-resume-proof',
          ok: true,
          output: 'resume-anchor-4812',
        }],
        output: 'resume-anchor-4812',
      }],
    };

    const result = await h.run(ctx);

    expect(result.ok).toBe(true);
    expect(ctx.reply).toContain('resume-anchor-4812');
    expect(ctx.taskExecution.status).toBe('done');
    expect(ctx.replyProvenance).toMatchObject({ purpose: 'execute_final_reply' });
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_final_reply',
    ]);
    expect((result.meta?.trace as Array<{ name: string }>).map((item) => item.name)).toEqual([
      'reply', 'verify', 'evolve', 'capture', 'finalize',
    ]);
    const requestText = String(llm.chat.mock.calls[0]?.[0].messages.at(-1)?.content ?? '');
    expect(requestText).toContain('resume-anchor-4812');
  });

  it('re-enters DECIDE for a task event received after EXECUTE and adopts a new TaskBook revision', async () => {
    const planningPrompts: string[] = [];
    const llm = createMockLlm((request) => {
      planningPrompts.push(String(request.messages.at(-1)?.content ?? ''));
      const revised = planningPrompts.length > 1;
      return textResponse(JSON.stringify({
        assessment: {
          userNeed: revised ? 'include the runtime verification update' : 'complete the original task',
          complexity: 'standard',
          goal: 'complete the task',
          successCriteria: [revised ? 'runtime verification is included' : 'the original task is complete'],
          requiresTaskBook: true,
        },
        taskBook: {
          goal: 'complete the task',
          complexity: 'standard',
          successCriteria: [revised ? 'runtime verification is included' : 'the original task is complete'],
          steps: [{
            id: 'step-1',
            description: revised ? 'complete the task and verify the runtime update' : 'complete the task',
          }],
        },
      }));
    });
    const h = makeHarness(llm);
    const runtimeQueue = createMutableRuntimeTaskQueue();
    let executeCalls = 0;
    h.registerStage('classify', async (ctx) => {
      ctx.classification = { type: 'problem', confidence: 1, source: 'rules', reason: 'integration test' };
      return { stage: 'classify', next: 'decide', ok: true };
    });
    h.registerStage('execute', async (ctx) => {
      executeCalls += 1;
      if (executeCalls === 1) {
        runtimeQueue.enqueue({
          version: RUNTIME_EVENT_VERSION,
          id: 'runtime-update-1',
          runId: ctx.runId,
          sessionId: ctx.sessionId,
          sequence: 1,
          type: 'user_message',
          source: 'app',
          status: 'queued',
          receivedAt: '2026-07-18T11:00:00.000Z',
          payload: { text: 'Add a verification step before delivery.' },
        });
        return { stage: 'execute', next: 'verify', ok: true };
      }
      return { stage: 'execute', next: 'finalize', ok: true };
    });
    h.registerStage('finalize', async () => ({
      stage: 'finalize', next: 'exit', ok: true,
    }));
    const ctx = makeCtx({ inbound: textMessage('user', 'complete the task') });
    ctx.runtimeEventQueue = runtimeQueue.port;

    const result = await h.run(ctx);

    expect(result.ok).toBe(true);
    expect(executeCalls).toBe(2);
    expect(planningPrompts).toHaveLength(2);
    expect(planningPrompts[1]).toContain('Add a verification step before delivery.');
    expect(ctx.taskBookRevision).toBe(2);
    expect(ctx.taskBook?.steps[0]?.description).toBe('complete the task and verify the runtime update');
    expect(ctx.deferredRuntimeEvents).toEqual([]);
    expect(ctx.deferredRuntimeEventIds).toEqual(['runtime-update-1']);
    const trace = result.meta?.trace as Array<{ name: string }>;
    expect(trace.map((item) => item.name)).toEqual([
      'enter', 'classify', 'decide', 'execute', 'decide', 'execute', 'finalize',
    ]);
  });

  it('unclear path: enter → classify(unclear) → ask_user → finalize → exit', async () => {
    // 'asdf qwer' matches no rule → LLM classify fallback returns truly unclear.
    // ASK_USER renders a first-class clarification request.
    const llm = createMockLlm([
      textResponse('{"type":"unclear","confidence":0.5,"reason":"ambiguous"}'),
      textResponse('what do you mean?'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({ inbound: textMessage('user', 'asdf qwer') });
    const res = await h.run(ctx);
    expect(res.next).toBe('exit');
    expect(ctx.reply).toBe('what do you mean?');
    const trace = res.meta?.trace as Array<{ name: string }>;
    const names = trace.map((t) => t.name);
    expect(names).toEqual(['enter', 'classify', 'ask_user', 'finalize']);
    expect(ctx.classification?.type).toBe('unclear');
    expect(ctx.clarificationRequest?.kind).toBe('ambiguous_request');
  });

  it('registerStage replaces a stage (Layer 2 editability)', async () => {
    const llm = createMockLlm(textResponse('hi'));
    const h = makeHarness(llm);
    let customEnterCalled = false;
    h.registerStage('enter', async () => {
      customEnterCalled = true;
      return {
        stage: 'enter',
        next: 'classify',
        ok: true,
        meta: { custom: true },
      };
    });
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });
    const res = await h.run(ctx);
    expect(res.ok).toBe(true);
    expect(customEnterCalled).toBe(true);
    const trace = res.meta?.trace as Array<{ name: string }>;
    expect(trace[0].name).toBe('enter'); // custom enter ran
  });

  it('on(void hook) is invoked at stage boundaries (Layer 3 editability)', async () => {
    const llm = createMockLlm(textResponse('hi'));
    const h = makeHarness(llm);
    const seen: string[] = [];
    h.on({
      kind: 'void',
      stage: 'classify',
      phase: 'after',
      priority: 0,
      run: async (ctx) => {
        seen.push(`after:classify:${ctx.classification?.type ?? ''}`);
      },
    });
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });
    await h.run(ctx);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe('after:classify:chat');
  });

  it('stage throwing is caught and returns ok:false with error', async () => {
    const llm = createMockLlm(textResponse('hi'));
    const h = makeHarness(llm);
    h.registerStage('classify', async () => {
      throw new Error('boom');
    });
    const ctx = makeCtx({ inbound: textMessage('user', 'hello') });
    const res = await h.run(ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('boom');
    expect(res.next).toBe('exit');
    const trace = res.meta?.trace as Array<{ name: string }>;
    // enter ran, then classify threw → loop exits
    expect(trace.map((t) => t.name)).toEqual(['enter', 'classify']);
  });

  it('rejects a custom stage or hook that invents an unregistered transition', async () => {
    const llm = createMockLlm(textResponse('unused'));
    const h = makeHarness(llm);
    h.registerStage('classify', async () => ({
      stage: 'classify',
      next: 'finalize',
      ok: true,
    }));

    const result = await h.run(makeCtx({ inbound: textMessage('user', 'hello') }));

    expect(result.ok).toBe(false);
    expect(result.next).toBe('exit');
    expect(result.error).toContain("invalid stage transition 'classify' -> 'finalize'");
    expect(result.meta?.transitionViolation).toMatchObject({
      from: 'classify',
      attempted: 'finalize',
    });
  });

  it('rejects execute -> decide without the guarded promotion request', async () => {
    const llm = createMockLlm(textResponse('unused'));
    const h = makeHarness(llm);
    h.registerStage('classify', async (ctx) => {
      ctx.classification = {
        activity: 'execute', type: 'problem', confidence: 1, source: 'rules', reasonCode: 'action_request',
        workPolicy: {
          version: 1, route: 'execute', sourceMessageId: String(ctx.inbound.id),
          executionMode: 'bounded_loop', reasonCode: 'bounded_single_goal',
        },
      };
      return { stage: 'classify', next: 'execute', ok: true };
    });
    h.registerStage('execute', async () => ({ stage: 'execute', next: 'decide', ok: true }));

    const result = await h.run(makeCtx({ inbound: textMessage('user', '帮我修复这个文件') }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid guarded stage transition 'execute' -> 'decide'");
    expect(result.error).toContain('persisted work-policy upgrade request');
  });

  it('applies the same promotion guard in the next Harness driver', async () => {
    const llm = createMockLlm(textResponse('unused'));
    const h = createNextHarness({
      ...baseDeps,
      llm,
      sessionManager: createMockSessionManager(),
      memoryStore: createMockMemoryStore(),
    });
    h.registerStage('classify', async (ctx) => {
      ctx.classification = {
        activity: 'execute', type: 'problem', confidence: 1, source: 'rules', reasonCode: 'action_request',
        workPolicy: {
          version: 1, route: 'execute', sourceMessageId: String(ctx.inbound.id),
          executionMode: 'bounded_loop', reasonCode: 'bounded_single_goal',
        },
      };
      return { stage: 'classify', next: 'execute', ok: true };
    });
    h.registerStage('execute', async () => ({ stage: 'execute', next: 'decide', ok: true }));

    const result = await h.run(makeCtx({ inbound: textMessage('user', '帮我修复这个文件') }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid guarded stage transition 'execute' -> 'decide'");
    expect(result.error).toContain('persisted work-policy upgrade request');
  });
});

function createMutableRuntimeTaskQueue(): {
  port: RuntimeEventQueueLike;
  enqueue: (event: RuntimeEventEnvelope) => void;
} {
  let queued: RuntimeEventEnvelope[] = [];
  let active: { token: string; events: RuntimeEventEnvelope[] } | undefined;
  let batchSequence = 0;
  const boundary = {
    openDecisionBatchForTypes(types: readonly RuntimeEventEnvelope['type'][]) {
      if (active) throw new Error('decision batch already active');
      const events = queued.filter((event) => types.includes(event.type));
      if (events.length === 0) return undefined;
      const token = `batch-${++batchSequence}`;
      active = { token, events };
      return {
        token,
        openedAt: '2026-07-18T11:00:01.000Z',
        cursor: 0,
        events: structuredClone(events),
      };
    },
    settleDecisionBatch(token: string, decisions: readonly RuntimeEventDecision[]) {
      if (!active || active.token !== token) throw new Error('decision batch token mismatch');
      const settledIds = new Set(active.events.map((event) => event.id));
      const settled = active.events.map((event) => {
        const decision = decisions.find((item) => item.eventId === event.id);
        if (!decision) throw new Error(`missing decision for ${event.id}`);
        return {
          ...event,
          status: decision.status,
          decisionReason: decision.reason,
        };
      });
      queued = queued.filter((event) => !settledIds.has(event.id));
      active = undefined;
      return settled;
    },
    releaseDecisionBatch(token: string) {
      if (!active || active.token !== token) return false;
      active = undefined;
      return true;
    },
  };
  return {
    port: boundary as unknown as RuntimeEventQueueLike,
    enqueue(event) {
      queued.push(structuredClone(event));
    },
  };
}
