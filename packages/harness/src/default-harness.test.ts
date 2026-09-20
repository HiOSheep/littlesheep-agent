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
  lastConversationText,
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
  it('chat path: enter → classify(chat via rules) → the main loop answers → finalize → exit', async () => {
    // 'hello' matches the greeting rule (confidence 0.9 ≥ 0.7) → no LLM for classify.
    // The main loop answers it in one call, so chat and tool turns share one prompt.
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
    expect(names).toContain('execute');
    expect(names).not.toContain('reply');
    expect(names[names.length - 1]).toBe('finalize');
    expect(ctx.reply).toBe('hi there');
    expect(ctx.classification).toMatchObject({ activity: 'execute', type: 'chat', source: 'rules' });
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual(['execute_tool_loop']);
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
    // Rule-matched conversation no longer gets a second prompt shape: the turn
    // runs in the main loop and still costs exactly one model request.
    expect(ctx.classification).toMatchObject({
      activity: 'execute',
      type: 'chat',
      source: 'rules',
      reason: 'direct response constraint',
      workPolicy: { executionMode: 'bounded_loop', reasonCode: 'conversational_default' },
    });
    expect(ctx.reply).toBe('LS-PROVIDER-OK-20260730-1610');
    expect((result.meta?.trace as Array<{ name: string }>).map((item) => item.name)).toEqual([
      'enter', 'classify', 'execute', 'verify', 'capture', 'finalize',
    ]);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(ctx.modelRequests).toHaveLength(1);
    expect(ctx.modelRequests?.[0]?.callContract?.purpose).toBe('execute_tool_loop');
  });

  it('problem path: enter → classify → execute(tool) → verify → evolve → capture → finalize → exit', async () => {
    const tool = makeTool('read', { ok: true, output: 'data' });
    // 'read the file' matches no routing rule, so it goes to the main loop: the
    // model proposes the tool, then answers. No routing, planning or
    // final-reply request is spent.
    // LLM queue: execute(tool call) → execute(stop) → evolve → capture
    const llm = createMockLlm([
      toolCallResponse([{ id: 'read-1', name: 'read', args: { path: 'file.txt' } }]),
      textResponse('The file was read successfully.'),
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
      'enter', 'classify', 'execute', 'verify', 'capture', 'finalize',
    ]);
    expect(ctx.classification?.type).toBe('problem');
    expect(ctx.classification?.reasonCode).toBe('deterministic_default_execute');
    expect(ctx.reply).toBe('The file was read successfully.');
    expect(ctx.replyProvenance).toMatchObject({ purpose: 'execute_tool_loop' });
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_tool_loop', 'execute_tool_loop',
    ]);
    expect(tool.calls).toHaveLength(1);
  });

  it('completes an explicit trivial read-only tool task without a DECIDE or VERIFY request', async () => {
    const tool = makeTool('glob', { ok: true, output: 'attachments/' });
    const llm = createMockLlm([
      toolCallResponse([{ id: 'glob-trivial', name: 'glob', args: { pattern: '*' } }]),
      textResponse('共有 1 个条目：attachments/'),
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
    // VERIFY no longer spends a model request. A lean bounded-loop run has no
    // task book whose acceptance the code could prove, so the run is recorded
    // as unverified rather than as a verified pass.
    expect(ctx.verificationHistory?.at(-1)).toMatchObject({ source: 'structural', verdict: 'unverified' });
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_tool_loop', 'execute_tool_loop',
    ]);
    expect(llm.chat.mock.calls.every((call) => (
      call[0].tools?.map((candidate) => candidate.function.name).join(',') === 'glob'
    ))).toBe(true);
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0]?.input).toEqual({ pattern: '*' });
  });

  it('regenerates and verifies a traceable task reply when an interrupted checkpoint points at ask_user', async () => {
    const llm = createMockLlm(textResponse('文件 resume-proof.txt 已核对，内容为 resume-anchor-4812。'));
    const h = makeHarness(llm);
    h.registerStage('verify', async () => ({ stage: 'verify', next: 'capture', ok: true }));
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
      'reply', 'verify', 'capture', 'finalize',
    ]);
    const requestText = lastConversationText(llm.chat.mock.calls[0]?.[0]);
    expect(requestText).toContain('resume-anchor-4812');
  });

  it('re-enters DECIDE for a task event received after EXECUTE and adopts a new TaskBook revision', async () => {
    const planningPrompts: string[] = [];
    const llm = createMockLlm((request) => {
      planningPrompts.push(lastConversationText(request));
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

  it('unmatched path: enter → classify(loop) → execute → verify → finalize → exit', async () => {
    // 'asdf qwer' matches no rule, so it goes to the main loop: the model's own
    // text is the answer and no clarification checkpoint is created.
    const llm = createMockLlm([
      textResponse('what do you mean?'),
    ]);
    const h = makeHarness(llm);
    const ctx = makeCtx({ inbound: textMessage('user', 'asdf qwer') });
    const res = await h.run(ctx);
    expect(res.next).toBe('exit');
    expect(ctx.reply).toBe('what do you mean?');
    const trace = res.meta?.trace as Array<{ name: string }>;
    const names = trace.map((t) => t.name);
    expect(names).toEqual(['enter', 'classify', 'execute', 'verify', 'capture', 'finalize']);
    expect(ctx.classification?.activity).toBe('execute');
    expect(ctx.classification?.reasonCode).toBe('deterministic_default_execute');
    expect(ctx.clarificationRequest).toBeUndefined();
    expect(ctx.modelRequests?.map((request) => request.callContract?.purpose)).toEqual([
      'execute_tool_loop',
    ]);
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
