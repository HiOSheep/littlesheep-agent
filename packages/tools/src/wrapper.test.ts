import { describe, it, expect } from 'vitest';
import { withToolTiming, type ToolHandler } from './wrapper.js';
import type { ToolContext, ToolResult } from '@littlesheep/types';

const ctx: ToolContext = {
  sessionId: 's1' as never,
  runId: 'r1',
  cwd: process.cwd(),
};

/** Small helper: pause so we can assert durationMs > 0 reliably. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('withToolTiming', () => {
  it('fills callId + durationMs on success', async () => {
    const wrapped = withToolTiming(async () => {
      await delay(5);
      return { output: 'done' };
    });
    const result = await wrapped({}, ctx);

    expect(result.ok).toBe(true);
    expect(result.callId).toBe('');
    expect(result.output).toBe('done');
    expect(result.durationMs).toBeGreaterThanOrEqual(1);
    expect(result.error).toBeUndefined();
  });

  it('defaults ok to true when omitted', async () => {
    const wrapped = withToolTiming(async () => ({ output: 'x' }));
    const result = await wrapped({}, ctx);
    expect(result.ok).toBe(true);
  });

  it('preserves ok:false returned by handler (business failure)', async () => {
    const wrapped = withToolTiming(async () => ({
      ok: false as const,
      error: 'File not found: /x',
    }));
    const result = await wrapped({}, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('File not found: /x');
    // durationMs must still be present on business-failure paths
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.callId).toBe('');
  });

  it('preserves meta + sanitized fields', async () => {
    const wrapped = withToolTiming(async () => ({
      output: 'data',
      sanitized: true,
      meta: { count: 3, exitCode: 0 },
    }));
    const result = await wrapped({}, ctx);

    expect(result.sanitized).toBe(true);
    expect(result.meta).toEqual({ count: 3, exitCode: 0 });
  });

  it('converts thrown Error to { ok:false, error } without rethrowing', async () => {
    const wrapped = withToolTiming(async () => {
      throw new Error('boom');
    });
    // Must NOT throw — contract is "execute must not throw"
    await expect(wrapped({}, ctx)).resolves.toMatchObject({
      ok: false,
      error: 'boom',
    });
  });

  it('converts thrown non-Error to stringified error', async () => {
    const wrapped = withToolTiming(async () => {
      throw 'string error'; // eslint-disable-line no-throw-literal
    });
    const result = await wrapped({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('string error');
  });

  it('still computes durationMs when handler throws', async () => {
    const wrapped = withToolTiming(async () => {
      await delay(5);
      throw new Error('late failure');
    });
    const result = await wrapped({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('late failure');
    expect(result.durationMs).toBeGreaterThanOrEqual(1);
  });

  it('waits for callback-style resolve (spawn pattern)', async () => {
    // Simulates exec.ts: handler returns a Promise that resolves from a
    // later callback. withToolTiming must await it and time correctly.
    const wrapped = withToolTiming(async () => {
      return await new Promise<Partial<ToolResult>>((resolve) => {
        setTimeout(() => resolve({ ok: true, output: 'exited', meta: { exitCode: 0 } }), 10);
      });
    });
    const result = await wrapped({}, ctx);

    expect(result.ok).toBe(true);
    expect(result.output).toBe('exited');
    expect((result.meta as { exitCode: number }).exitCode).toBe(0);
    // Callback fired after ~10ms — durationMs must reflect that.
    expect(result.durationMs).toBeGreaterThanOrEqual(8);
  });

  it('passes input + ctx through to handler', async () => {
    const handler: ToolHandler<{ x: number }> = async (input, c) => {
      expect(input.x).toBe(42);
      expect(c.runId).toBe('r1');
      return { output: 'seen' };
    };
    const wrapped = withToolTiming<{ x: number }>(handler);
    const result = await wrapped({ x: 42 }, ctx);
    expect(result.output).toBe('seen');
  });
});
