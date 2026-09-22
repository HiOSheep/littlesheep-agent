import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  AgentTool,
  NetworkReadPolicy,
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

  it('records a declared, bounded error kind instead of a generic failure', async () => {
    const stale = vi.fn(async () => ({
      callId: '',
      ok: false,
      error: 'notes.md changed after it was read; read it again before overwriting it',
      meta: { errorKind: 'observation_stale' },
    } satisfies ToolResult));
    const sloppy = vi.fn(async () => ({
      callId: '',
      ok: false,
      error: 'refused',
      meta: { errorKind: 'Not A Bounded Kind!' },
    } satisfies ToolResult));
    const service = createService([
      registration(tool('guarded', stale), 'builtin'),
      registration(tool('sloppy', sloppy), 'plugin:sloppy'),
    ]);

    await service.executeBatch([
      { callId: 'guarded-call', name: 'guarded', input: { value: 'x' } },
      { callId: 'sloppy-call', name: 'sloppy', input: { value: 'x' } },
    ]);

    expect(service.snapshot().records).toMatchObject([
      { toolName: 'guarded', status: 'failed', errorKind: 'observation_stale' },
      // A plugin cannot smuggle free-form text into the audit field.
      { toolName: 'sloppy', status: 'failed', errorKind: 'failed' },
    ]);
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

  it('rejects unknown web fields before approval and execution', async () => {
    const approve = vi.fn(async () => true);
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const strictWebTool: AgentTool = {
      name: 'web_search',
      description: 'strict web fixture',
      inputSchema: z.object({ query: z.string() }).strict(),
      execute,
    };
    const service = createService([registration(strictWebTool, 'builtin')], {
      toolContext: { permissionMode: 'restricted', networkPolicy: webPolicy(), approve },
    });

    const results = await service.executeBatch([{
      callId: 'invalid-web',
      name: 'web_search',
      input: { query: 'public docs', headers: { Authorization: 'Bearer fixture-secret' } },
    }]);

    expect(results.get(0)).toMatchObject({ ok: false });
    expect(service.snapshot().records[0]).toMatchObject({ status: 'validation_failed', errorKind: 'input_validation' });
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses projected web input for approval, events and records without persisting model-only evidence', async () => {
    const secret = 'fixture-secret-value';
    const pageBody = 'CURRENT_WEB_BODY_SENTINEL';
    const approve = vi.fn(async () => true);
    const events: ToolStreamEvent[] = [];
    const web: AgentTool = {
      name: 'web_search',
      description: 'projected web fixture',
      inputSchema: z.object({ query: z.string() }).strict(),
      persistence: {
        projectInput(input) {
          const query = String((input as { query?: unknown }).query ?? '');
          return { queryHash: `hash:${query.length}`, sensitiveQuery: true, sensitiveCategories: ['credential'] };
        },
      },
      async execute() {
        return {
          callId: '', ok: true,
          output: JSON.stringify({ citationIds: ['web-citation-1'] }),
          modelOutput: { externalUntrusted: true, content: pageBody },
        };
      },
    };
    const service = createService([registration(web, 'builtin')], {
      onToolEvent: (event) => events.push(event),
      toolContext: {
        permissionMode: 'restricted',
        networkPolicy: webPolicy({ sensitiveQueryPolicy: 'approve' }),
        approve,
      },
    });

    const results = await service.executeBatch([{
      callId: 'sensitive-web', name: 'web_search', input: { query: `find api_key=${secret} docs` },
    }]);

    expect(String(results.get(0)?.modelOutput)).toContain(pageBody);
    expect(String(results.get(0)?.modelOutput)).toContain('externalUntrusted');
    expect(approve).toHaveBeenCalledWith('web_search', expect.objectContaining({
      queryHash: expect.any(String), sensitiveQuery: true, sensitiveCategories: ['credential'],
    }));
    const durableAudit = JSON.stringify({ events, snapshot: service.snapshot() });
    expect(durableAudit).not.toContain(secret);
    expect(durableAudit).not.toContain(pageBody);
    expect(durableAudit).toContain('queryHash');
    expect(durableAudit).toContain('web-citation-1');
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
    const events: ToolStreamEvent[] = [];
    const execute = vi.fn(async (_input: unknown, context: ToolContext) => ({
      callId: '', ok: context.approvalGranted === true,
    } satisfies ToolResult));
    const service = createService([
      registration(tool('guarded', execute, { requiresApproval: true }), 'builtin'),
    ], { toolContext: { approve }, onToolEvent: (event) => events.push(event) });

    const results = await service.executeBatch([
      { callId: 'approved', name: 'guarded', input: { value: 'x' } },
    ]);

    expect(results.get(0)?.ok).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]?.approvalGranted).toBe(true);
    expect(events.map((event) => [event.type, event.activityStatus])).toEqual([
      ['runtime_activity', 'running'],
      ['runtime_activity', 'done'],
      ['tool_start', undefined],
      ['tool_end', undefined],
    ]);
    expect(events[0]).toMatchObject({
      activityKind: 'runtime_waiting_approval', callId: 'approved', name: 'guarded',
    });
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

  it('records unknown and non-admitted tools without executing them', async () => {
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const service = createService([
      registration(tool('known', execute), 'plugin:known'),
    ]);

    const results = await service.executeBatch([
      { callId: 'unknown', name: 'missing', input: {} },
      { callId: 'disallowed', name: 'known', input: { value: 'x' } },
    ], undefined, new Set());

    expect([...results.values()].every((result) => result.ok === false)).toBe(true);
    expect(service.snapshot().records).toMatchObject([
      { toolName: 'missing', toolSource: 'unknown', status: 'unknown_tool', errorKind: 'unknown_tool' },
      { toolName: 'known', toolSource: 'plugin:known', status: 'validation_failed', errorKind: 'step_tool_not_allowed' },
    ]);
    expect(results.get(1)?.error).toContain('registered');
    expect(results.get(1)?.error).toContain('not admitted for the current request');
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

  it.each(['full', 'research', 'restricted'] as const)(
    'hard-denies disabled web_search before approval, repeat accounting, and execution in %s mode',
    async (permissionMode) => {
      const approve = vi.fn(async () => true);
      const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
      const service = createService([
        registration(webTool('web_search', execute), 'builtin'),
      ], {
        maxRepeat: 1,
        toolContext: {
          permissionMode,
          networkPolicy: webPolicy({ enabled: false, mode: 'disabled' }),
          approve,
        },
      });

      const results = await service.executeBatch([
        { callId: `${permissionMode}-disabled-1`, name: 'web_search', input: { query: 'same query' } },
        { callId: `${permissionMode}-disabled-2`, name: 'web_search', input: { query: 'same query' } },
      ]);

      expect([...results.values()].every((result) => result.ok === false)).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(approve).not.toHaveBeenCalled();
      expect(service.snapshot().records.map((record) => record.status)).toEqual(['hard_denied', 'hard_denied']);
      expect(service.snapshot().records.every((record) => (
        record.approval.required === false
        && record.approval.decision === 'blocked'
        && record.errorKind === 'hard_deny'
      ))).toBe(true);
    },
  );

  it.each(['full', 'research', 'restricted'] as const)(
    'hard-denies private web_fetch targets even in %s mode',
    async (permissionMode) => {
      const approve = vi.fn(async () => true);
      const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
      const service = createService([
        registration(webTool('web_fetch', execute), 'builtin'),
      ], {
        toolContext: {
          permissionMode,
          networkPolicy: webPolicy(),
          approve,
        },
      });

      const result = await service.executeBatch([{
        callId: `${permissionMode}-private-fetch`,
        name: 'web_fetch',
        input: { url: 'http://127.0.0.1:8080/admin' },
      }]);

      expect(result.get(0)?.ok).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(approve).not.toHaveBeenCalled();
      expect(service.snapshot().records[0]).toMatchObject({
        status: 'hard_denied',
        approval: { required: false, decision: 'blocked' },
        errorKind: 'hard_deny',
      });
    },
  );

  it('does not ask for approval for local memory, local session, or enabled public web safe reads in restricted mode', async () => {
    const approve = vi.fn(async () => true);
    const executions = new Map<string, ReturnType<typeof vi.fn>>();
    const registrations = ['memory_search', 'session_status', 'web_search'].map((name) => {
      const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
      executions.set(name, execute);
      return registration(webLikeTool(name, execute), 'builtin');
    });
    const service = createService(registrations, {
      toolContext: {
        permissionMode: 'restricted',
        networkPolicy: webPolicy(),
        approve,
      },
    });

    const results = await service.executeBatch([
      { callId: 'local-memory', name: 'memory_search', input: { value: 'memory' } },
      { callId: 'local-session', name: 'session_status', input: { value: 'session' } },
      { callId: 'public-search', name: 'web_search', input: { query: 'latest public docs' } },
    ]);

    expect([...results.values()].every((result) => result.ok)).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    for (const execute of executions.values()) expect(execute).toHaveBeenCalledTimes(1);
    expect(service.snapshot().records.map((record) => record.approval)).toEqual([
      expect.objectContaining({ required: false, decision: 'not_required' }),
      expect.objectContaining({ required: false, decision: 'not_required' }),
      expect.objectContaining({ required: false, decision: 'not_required' }),
    ]);
  });

  it('restores approval for safe web reads under strictReadApproval, while full mode still bypasses ordinary approval', async () => {
    for (const permissionMode of ['research', 'restricted'] as const) {
      const approve = vi.fn(async () => true);
      const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
      const service = createService([
        registration(webTool('web_search', execute), 'builtin'),
      ], {
        toolContext: {
          permissionMode,
          networkPolicy: webPolicy({ strictReadApproval: true }),
          approve,
        },
      });

      await service.executeBatch([{ callId: `${permissionMode}-strict`, name: 'web_search', input: { query: 'strict' } }]);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(service.snapshot().records[0]).toMatchObject({
        status: 'succeeded',
        approval: { required: true, decision: 'approved' },
      });
    }

    const approve = vi.fn(async () => true);
    const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
    const service = createService([
      registration(webTool('web_search', execute), 'builtin'),
    ], {
      toolContext: {
        permissionMode: 'full',
        networkPolicy: webPolicy({ strictReadApproval: true }),
        approve,
      },
    });
    await service.executeBatch([{ callId: 'full-strict', name: 'web_search', input: { query: 'strict' } }]);
    expect(approve).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(service.snapshot().records[0]).toMatchObject({
      status: 'succeeded',
      approval: { required: false, decision: 'not_required' },
    });
  });

  it('does not let the safe-read exception authorize ordinary file reads, writes, or exec', async () => {
    const approve = vi.fn(async () => false);
    const executions = new Map<string, ReturnType<typeof vi.fn>>();
    const registrations = ['read', 'write', 'exec'].map((name) => {
      const execute = vi.fn(async () => ({ callId: '', ok: true } satisfies ToolResult));
      executions.set(name, execute);
      return registration(webLikeTool(name, execute), 'builtin');
    });
    const service = createService(registrations, {
      toolContext: {
        permissionMode: 'restricted',
        networkPolicy: webPolicy(),
        approve,
      },
    });

    const results = await service.executeBatch([
      { callId: 'ordinary-read', name: 'read', input: { value: 'read' } },
      { callId: 'ordinary-write', name: 'write', input: { value: 'write' } },
      { callId: 'ordinary-exec', name: 'exec', input: { value: 'exec' } },
    ]);

    expect([...results.values()].every((result) => result.ok === false)).toBe(true);
    expect(approve).toHaveBeenCalledTimes(3);
    for (const execute of executions.values()) expect(execute).not.toHaveBeenCalled();
    expect(service.snapshot().records.map((record) => record.status)).toEqual([
      'approval_denied',
      'approval_denied',
      'approval_denied',
    ]);
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

function webPolicy(overrides: Partial<NetworkReadPolicy> = {}): NetworkReadPolicy {
  return {
    version: 1,
    enabled: true,
    providerId: 'tavily',
    mode: 'public_anonymous',
    allowDomains: [],
    blockDomains: [],
    strictReadApproval: false,
    maxResults: 10,
    maxQueryChars: 2_000,
    maxQueriesPerRun: 4,
    maxFetchesPerRun: 4,
    maxConcurrentRequests: 4,
    searchTimeoutMs: 15_000,
    fetchTimeoutMs: 20_000,
    totalTimeoutMs: 90_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxExtractedChars: 40_000,
    maxRedirects: 5,
    cacheEnabled: true,
    cacheTtlSeconds: 300,
    cacheMaxBytes: 64 * 1024 * 1024,
    browserFallback: 'approval_required',
    sensitiveQueryPolicy: 'approve',
    ...overrides,
  };
}

function webTool(
  name: 'web_search' | 'web_fetch',
  execute: AgentTool['execute'],
): AgentTool {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: name === 'web_search'
      ? z.object({ query: z.string() })
      : z.object({ url: z.string() }),
    requiresApproval: true,
    execute,
  };
}

function webLikeTool(
  name: string,
  execute: AgentTool['execute'],
): AgentTool {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: name === 'web_search'
      ? z.object({ query: z.string() })
      : z.object({ value: z.string() }),
    execute,
  };
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
