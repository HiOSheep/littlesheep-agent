// @littlesheep/harness — hooks/runner.test.ts
import { describe, it, expect } from 'vitest';
import { HookRunner } from './runner.js';
import { makeCtx } from '../tests/helpers.js';
import type { StageResult, AnyHook } from '@littlesheep/types';

const ok: StageResult = { stage: 'execute', next: 'evolve', ok: true };

describe('HookRunner', () => {
  it('runs void before/after hooks', async () => {
    const runner = new HookRunner();
    const calls: string[] = [];
    runner.register({ kind: 'void', stage: 'execute', phase: 'before', run: async () => { calls.push('before'); } });
    runner.register({ kind: 'void', stage: 'execute', phase: 'after', run: async () => { calls.push('after'); } });
    const ctx = makeCtx();
    await runner.runBefore(ctx, 'execute');
    expect(calls).toEqual(['before']);
    await runner.runAfter(ctx, 'execute', ok);
    expect(calls).toEqual(['before', 'after']);
  });

  it('runs higher priority first', async () => {
    const runner = new HookRunner();
    const calls: string[] = [];
    runner.register({ kind: 'void', stage: 'execute', phase: 'before', priority: 1, run: async () => { calls.push('low'); } });
    runner.register({ kind: 'void', stage: 'execute', phase: 'before', priority: 10, run: async () => { calls.push('high'); } });
    await runner.runBefore(makeCtx(), 'execute');
    expect(calls).toEqual(['high', 'low']);
  });

  it('keeps registration order at equal priority', async () => {
    const runner = new HookRunner();
    const calls: string[] = [];
    runner.register({ kind: 'void', stage: 'execute', phase: 'before', priority: 5, run: async () => { calls.push('first'); } });
    runner.register({ kind: 'void', stage: 'execute', phase: 'before', priority: 5, run: async () => { calls.push('second'); } });
    await runner.runBefore(makeCtx(), 'execute');
    expect(calls).toEqual(['first', 'second']);
  });

  it('modifying after can replace result', async () => {
    const runner = new HookRunner();
    const replaced: StageResult = { stage: 'execute', next: 'finalize', ok: true, meta: { replaced: true } };
    runner.register({
      kind: 'modifying', stage: 'execute', phase: 'after',
      run: async () => replaced,
    });
    const result = await runner.runAfter(makeCtx(), 'execute', ok);
    expect(result).toBe(replaced);
  });

  it('claiming hook skips default stage', async () => {
    const runner = new HookRunner();
    const claimed: StageResult = { stage: 'decide', next: 'execute', ok: true, meta: { claimed: true } };
    runner.register({ kind: 'claiming', stage: 'decide', claim: async () => claimed });
    const { claimed: got } = await runner.runBefore(makeCtx(), 'decide');
    expect(got).toBe(claimed);
  });

  it('claiming returns null → no claim', async () => {
    const runner = new HookRunner();
    runner.register({ kind: 'claiming', stage: 'decide', claim: async () => null });
    const { claimed } = await runner.runBefore(makeCtx(), 'decide');
    expect(claimed).toBeUndefined();
  });

  it('star stage matches all stages', async () => {
    const runner = new HookRunner();
    const calls: string[] = [];
    const hook: AnyHook = { kind: 'void', stage: '*', phase: 'before', run: async (ctx) => { calls.push(ctx.sessionId); } };
    runner.register(hook);
    await runner.runBefore(makeCtx(), 'enter');
    await runner.runBefore(makeCtx(), 'execute');
    expect(calls.length).toBe(2);
  });

  it('void hook throwing does not abort (continue policy)', async () => {
    const runner = new HookRunner();
    const calls: string[] = [];
    runner.register({ kind: 'void', stage: 'execute', phase: 'before', run: async () => { throw new Error('boom'); } });
    runner.register({ kind: 'void', stage: 'execute', phase: 'before', run: async () => { calls.push('after-boom'); } });
    await runner.runBefore(makeCtx(), 'execute');
    expect(calls).toEqual(['after-boom']);
  });

  it('modifying hook throwing degrades to no-op', async () => {
    const runner = new HookRunner();
    runner.register({
      kind: 'modifying', stage: 'execute', phase: 'after',
      run: async () => { throw new Error('mod boom'); },
    });
    const result = await runner.runAfter(makeCtx(), 'execute', ok);
    expect(result).toBe(ok);
  });

  it('claiming hook throwing → not claimed', async () => {
    const runner = new HookRunner();
    runner.register({ kind: 'claiming', stage: 'decide', claim: async () => { throw new Error('claim boom'); } });
    const { claimed } = await runner.runBefore(makeCtx(), 'decide');
    expect(claimed).toBeUndefined();
  });

  it('hooksFor returns matching hooks', () => {
    const runner = new HookRunner();
    const h1: AnyHook = { kind: 'void', stage: 'execute', phase: 'before', run: async () => {} };
    const h2: AnyHook = { kind: 'void', stage: 'decide', phase: 'before', run: async () => {} };
    runner.register(h1);
    runner.register(h2);
    expect(runner.hooksFor('execute')).toHaveLength(1);
    expect(runner.hooksFor('decide')).toHaveLength(1);
  });

  it('ordering: void → modifying → claiming (before)', async () => {
    const runner = new HookRunner();
    const order: string[] = [];
    runner.register({ kind: 'claiming', stage: 'execute', claim: async () => null, }); // returns null → doesn't claim
    runner.register({ kind: 'modifying', stage: 'execute', phase: 'before', run: async () => { order.push('mod'); } });
    runner.register({ kind: 'void', stage: 'execute', phase: 'before', run: async () => { order.push('void'); } });
    await runner.runBefore(makeCtx(), 'execute');
    expect(order).toEqual(['void', 'mod']);
  });
});
