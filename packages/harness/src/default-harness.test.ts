// @littlesheep/harness — default-harness.test.ts
// Verifies the Core Flow state machine: hard-coded transitions via switch (D6).
// LLM never chooses the stage; it only decides within a stage.
import { describe, it, expect } from 'vitest';
import { createDefaultHarness } from './default-harness.js';
import {
  createMockLlm,
  textResponse,
  makeCtx,
  makeTool,
  createMockSessionManager,
  createMockMemoryStore,
} from './tests/helpers.js';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { textMessage } from '@littlesheep/types';

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

  it('problem path: enter → classify → decide → execute(stop) → verify(pass) → evolve → capture → finalize → exit', async () => {
    const tool = makeTool('read', { ok: true, output: 'data' });
    // 'read the file' doesn't match any rule → LLM classify fallback.
    // LLM queue: classify → decide → execute(stop) → verify(pass) → evolve → capture
    const llm = createMockLlm([
      textResponse('{"type":"problem","confidence":0.9,"reason":"task"}'),
      textResponse('{"plan":[{"description":"read it","tools":["read"]}]}'),
      textResponse('done', 'stop'),
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
});
