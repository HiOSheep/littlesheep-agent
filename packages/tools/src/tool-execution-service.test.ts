import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  AgentTool,
  ToolContext,
  ToolRegistration,
  ToolResult,
  ToolStreamEvent,
} from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import { ToolExecutionService } from './tool-execution-service.js';

describe('ToolExecutionService', () => {
  it('owns validation, execution, sanitation, events, and source-aware records', async () => {
    const execute = vi.fn(async (input: unknown) => ({
      callId: '', ok: true, output: { accepted: input },
    } satisfies ToolResult));
    const events: ToolStreamEvent[] = [];
    const service = createService([
      registration(tool('inspect', execute), 'plugin:sample'),
    ], { onToolEvent: (event) => events.push(event) });

    const results = await service.executeBatch([
      { callId: 'call-1', name: 'inspect', input: { value: 'yes', ignored: true }, stepId: 'step-1' },
    ]);

    expect(results.get(0)).toMatchObject({ callId: 'call-1', ok: true, meta: { stepId: 'step-1' } });
    expect(execute).toHaveBeenCalledWith(
      { value: 'yes' },
      expect.objectContaining({ runId: 'run-1' }),
    );
    expect(events.map((event) => event.type)).toEqual(['tool_start', 'tool_end']);
    expect(service.snapshot().records[0]).toMatchObject({
      callId: 'call-1',
      toolName: 'inspect',
      toolSource: 'plugin:sample',
      status: 'succeeded',
      approval: { required: false, decision: 'not_required' },
      stepId: 'step-1',
    });
  });

  it('rejects invalid input before approval or execution', async () => {
    const approve = vi.fn(async () => true);
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const service = createService([
      registration(tool('strict', execute, { requiresApproval: true }), 'builtin'),
    ], { toolContext: { approve } });

    const results = await service.executeBatch([
      { callId: 'invalid', name: 'strict', input: {} },
    ]);

    expect(results.get(0)?.error).toContain('validation failed');
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(service.snapshot().records[0]?.status).toBe('validation_failed');
  });

  it('records approval denial without invoking the tool', async () => {
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const service = createService([
      registration(tool('guarded', execute, { requiresApproval: true }), 'builtin'),
    ], { toolContext: { approve: async () => false } });

    const results = await service.executeBatch([
      { callId: 'denied', name: 'guarded', input: { value: 'x' } },
    ]);

    expect(results.get(0)?.error).toContain('denied');
    expect(execute).not.toHaveBeenCalled();
    expect(service.snapshot().records[0]).toMatchObject({
      status: 'approval_denied',
      approval: { required: true, decision: 'denied' },
    });
  });

  it('fails closed when approval is unavailable or throws', async () => {
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const unavailable = createService([
      registration(tool('guarded', execute, { requiresApproval: true }), 'builtin'),
    ]);
    const errored = createService([
      registration(tool('guarded', execute, { requiresApproval: true }), 'builtin'),
    ], { toolContext: { approve: async () => { throw new Error('approval transport failed'); } } });

    await unavailable.executeBatch([{ callId: 'missing', name: 'guarded', input: { value: 'x' } }]);
    await errored.executeBatch([{ callId: 'errored', name: 'guarded', input: { value: 'x' } }]);

    expect(unavailable.snapshot().records[0]).toMatchObject({
      status: 'approval_unavailable', approval: { decision: 'unavailable' },
    });
    expect(errored.snapshot().records[0]).toMatchObject({
      status: 'approval_denied', approval: { decision: 'error' }, errorKind: 'approval_error',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes one invocation-scoped approval to the tool', async () => {
    const approve = vi.fn(async () => true);
    const execute = vi.fn(async (_input: unknown, context: ToolContext) => ({
      callId: '', ok: context.approvalGranted === true,
    } satisfies ToolResult));
    const service = createService([
      registration(tool('guarded', execute, { requiresApproval: true }), 'builtin'),
    ], { toolContext: { approve } });

    const results = await service.executeBatch([
      { callId: 'approved', name: 'guarded', input: { value: 'x' } },
    ]);

    expect(results.get(0)?.ok).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]?.approvalGranted).toBe(true);
  });

  it('interrupts approval waiting without invoking an already-aborted approver', async () => {
    const controller = new AbortController();
    controller.abort();
    const approve = vi.fn(async () => true);
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const service = createService([
      registration(tool('guarded', execute, { requiresApproval: true }), 'builtin'),
    ], { toolContext: { approve, signal: controller.signal } });

    const results = await service.executeBatch([
      { callId: 'approval-abort', name: 'guarded', input: { value: 'x' } },
    ]);

    expect(results.get(0)?.error).toBe('approval aborted');
    expect(service.snapshot().records[0]).toMatchObject({
      status: 'aborted', errorKind: 'approval_aborted', approval: { decision: 'error' },
    });
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('aborts the invocation signal and records a timeout', async () => {
    let signalWasAborted = false;
    const execute = vi.fn(async (_input: unknown, context: ToolContext) => new Promise<ToolResult>((_resolve, reject) => {
      context.signal?.addEventListener('abort', () => {
        signalWasAborted = true;
        reject(new Error('underlying tool stopped'));
      }, { once: true });
    }));
    const service = createService([
      registration(tool('slow', execute), 'builtin'),
    ], { timeoutMs: 10 });

    const results = await service.executeBatch([
      { callId: 'timeout', name: 'slow', input: { value: 'x' } },
    ]);

    expect(results.get(0)?.error).toContain('timed out');
    expect(signalWasAborted).toBe(true);
    expect(service.snapshot().records[0]?.status).toBe('timed_out');
  });

  it('waits briefly for an aborted tool to finish cleanup before recording timeout', async () => {
    let cleanupFinishedAt = 0;
    const execute = vi.fn(async (_input: unknown, context: ToolContext) => new Promise<ToolResult>((resolve) => {
      context.signal?.addEventListener('abort', () => {
        setTimeout(() => {
          cleanupFinishedAt = Date.now();
          resolve({ callId: '', ok: false, error: 'stopped after cleanup' });
        }, 40);
      }, { once: true });
    }));
    const service = createService([
      registration(tool('cleanup-aware', execute), 'plugin:sample'),
    ], { timeoutMs: 10 });

    await service.executeBatch([
      { callId: 'cleanup-timeout', name: 'cleanup-aware', input: { value: 'x' } },
    ]);

    expect(cleanupFinishedAt).toBeGreaterThan(0);
    expect(service.snapshot().records[0]).toMatchObject({
      status: 'timed_out',
      errorKind: 'timed_out',
    });
  });

  it('records a parent-run abort independently from timeout', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_input: unknown, context: ToolContext) => new Promise<ToolResult>((_resolve, reject) => {
      context.signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      controller.abort();
    }));
    const service = createService([
      registration(tool('interruptible', execute), 'builtin'),
    ], { timeoutMs: 1_000, toolContext: { signal: controller.signal } });

    await service.executeBatch([
      { callId: 'abort', name: 'interruptible', input: { value: 'x' } },
    ]);

    expect(service.snapshot().records[0]?.status).toBe('aborted');
  });

  it('marks sanitized output truncation without retaining output content in its record', async () => {
    const privateOutput = 'private '.repeat(100);
    const service = createService([
      registration(tool('verbose', async () => ({ callId: '', ok: true, output: privateOutput })), 'run-scoped'),
    ], { sanitize: { maxOutputChars: 60, stripImages: true } });

    const results = await service.executeBatch([
      { callId: 'verbose', name: 'verbose', input: { value: 'x' } },
    ]);
    const record = service.snapshot().records[0];

    expect(results.get(0)?.output).toContain('[truncated:');
    expect(record).toMatchObject({ toolSource: 'run-scoped', outputSanitized: true, outputTruncated: true });
    expect(JSON.stringify(record)).not.toContain(privateOutput);
  });

  it('records unknown and step-disallowed tools without executing them', async () => {
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const service = createService([
      registration(tool('known', execute), 'plugin:known'),
    ]);

    const results = await service.executeBatch([
      { callId: 'unknown', name: 'missing', input: {} },
      { callId: 'disallowed', name: 'known', input: { value: 'x' } },
    ], undefined, new Set());

    expect([...results.values()].every((result) => result.ok === false)).toBe(true);
    expect(service.snapshot().records.map((record) => record.status)).toEqual(['unknown_tool', 'unknown_tool']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks a fourth identical call across batches and bounds retained records', async () => {
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const service = createService([
      registration(tool('repeatable', execute), 'builtin'),
    ], { maxRepeat: 3, maxRecords: 2 });

    for (let index = 1; index <= 4; index += 1) {
      await service.executeBatch([
        { callId: `repeat-${index}`, name: 'repeatable', input: { value: 'same' } },
      ]);
    }

    expect(execute).toHaveBeenCalledTimes(3);
    expect(service.snapshot()).toMatchObject({ truncated: true });
    expect(service.snapshot().records).toHaveLength(2);
  });

  it('lets lifecycle guards fail closed before tool execution', async () => {
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const service = createService([
      registration(tool('mutate', execute), 'plugin:mutation'),
    ]);

    const results = await service.executeBatch([
      { callId: 'checkpoint', name: 'mutate', input: { value: 'x' } },
    ], {
      beforeInvoke: async () => ({
        result: { callId: 'checkpoint', ok: false, error: 'checkpoint is not durable' },
        status: 'failed',
        errorKind: 'checkpoint_before_effect',
      }),
    });

    expect(results.get(0)?.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(service.snapshot().records[0]).toMatchObject({
      status: 'failed', errorKind: 'checkpoint_before_effect',
    });
  });

  it('rejects a parallel branch tool that exceeds its declared resource envelope', async () => {
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const value = tool('scoped-read', execute);
    value.execution = {
      concurrency: 'parallel',
      resources: () => [{ key: 'fs:/workspace/private/file.txt', mode: 'read' }],
    };
    const service = createService([registration(value, 'builtin')]);

    const results = await service.executeBatch([{
      callId: 'outside-envelope',
      name: 'scoped-read',
      input: { value: 'x' },
      stepId: 'parallel-step',
      parallelStep: {
        sideEffect: 'read',
        resources: [{ key: 'fs:/workspace/public', mode: 'read' }],
      },
    }]);

    expect(results.get(0)).toMatchObject({ ok: false, error: expect.stringContaining('resource envelope') });
    expect(execute).not.toHaveBeenCalled();
    expect(service.snapshot().records[0]).toMatchObject({ status: 'validation_failed', errorKind: 'parallel_step_contract' });
  });

  it('serializes approval callbacks across concurrent batches', async () => {
    let active = 0;
    let maxActive = 0;
    const approve = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return true;
    });
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const service = createService([
      registration(tool('guarded', execute, { requiresApproval: true }), 'builtin'),
    ], { toolContext: { approve } });

    await Promise.all([
      service.executeBatch([{ callId: 'approval-a', name: 'guarded', input: { value: 'a' } }]),
      service.executeBatch([{ callId: 'approval-b', name: 'guarded', input: { value: 'b' } }]),
    ]);

    expect(approve).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

function createService(
  registrations: ToolRegistration[],
  options: {
    toolContext?: Partial<ToolContext>;
    timeoutMs?: number;
    maxRepeat?: number;
    maxRecords?: number;
    sanitize?: { maxOutputChars: number; stripImages: boolean };
    onToolEvent?: (event: ToolStreamEvent) => void;
  } = {},
): ToolExecutionService {
  return new ToolExecutionService({
    registrations,
    toolContext: {
      runId: 'run-1',
      sessionId: asSessionId('session-1'),
      cwd: process.cwd(),
      ...options.toolContext,
    },
    timeoutMs: options.timeoutMs,
    maxRepeat: options.maxRepeat,
    maxRecords: options.maxRecords,
    sanitize: options.sanitize,
    onToolEvent: options.onToolEvent,
  });
}

function registration(value: AgentTool, source: string): ToolRegistration {
  return { tool: value, source };
}

function tool(
  name: string,
  execute: AgentTool['execute'],
  options: { requiresApproval?: boolean } = {},
): AgentTool {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: z.object({ value: z.string() }),
    requiresApproval: options.requiresApproval,
    execute,
  };
}
