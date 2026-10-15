import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ShellApprovalBatch, ToolContext } from '@littlesheep/types';
import { createExecTool } from './builtin/exec.js';
import { ToolExecutionService } from './tool-execution-service.js';
import { attachShellInvocation, authorizeShellBatch, bindShellApprovalAuthority, shellApprovalMetrics, startAuthorizedShell } from './shell-authorization.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(request: (batch: ShellApprovalBatch) => Promise<boolean> = async () => true) {
  const root = await mkdtemp(join(tmpdir(), 'ls-shell-s1-')); roots.push(root);
  const controller = new AbortController();
  let current = 'policy:1';
  let decision: 'allow' | 'approval' | 'deny' | 'unavailable' = 'approval';
  const approve = vi.fn(async () => true);
  const ctx: ToolContext = { cwd: root, workspaceRoot: root, sessionId: 'session-a' as never,
    runId: 'run-a', approve, signal: controller.signal };
  const ask = vi.fn(request);
  bindShellApprovalAuthority(approve, { runId: ctx.runId, sessionId: String(ctx.sessionId), workspaceRoot: root,
    workspaceId: 'workspace-a', permission: { version: 2, preset: 'workspace-write' }, signal: controller.signal,
    current: async () => current, decide: () => decision, request: ask });
  const tool = createExecTool({ interactive: false });
  const items = (commands: string[]) => commands.map((command, index) => ({ index, tool, input: { command, timeout_ms: 20_000 } }));
  const prepare = (commands = ['echo fixture']) => authorizeShellBatch(items(commands), ctx, 30_000);
  const use = async (token: object, input: unknown = { command: 'echo fixture', timeout_ms: 20_000 }, context = ctx) => {
    const invocation = { ...context }; attachShellInvocation(invocation, tool, token);
    return startAuthorizedShell(invocation, tool, input, (plan) => plan.description);
  };
  return { root, ctx, tool, ask, approve, controller, items, prepare, use,
    setCurrent(value: string) { current = value; }, setDecision(value: typeof decision) { decision = value; } };
}

describe('S1 exact invocation authorization', () => {
  it('freezes concrete batch descriptions and consumes each independent invocation once', async () => {
    const f = await fixture();
    const batch = await f.prepare(['echo fixture', 'echo fixture']);
    expect(f.ask).toHaveBeenCalledTimes(1);
    const projection = f.ask.mock.calls[0]![0];
    expect(projection.scope).toBe('batch');
    expect(projection.commands[0]!.invocationId).not.toBe(projection.commands[1]!.invocationId);
    expect(Object.isFrozen(projection.commands)).toBe(true);
    expect(projection.commands[0]!.shell.path).toMatch(process.platform === 'win32' ? /^[A-Z]:\\/i : /^\//);
    expect(projection.commands[0]!.timeoutMs).toBe(20_000);
    expect(projection.commands[0]!.source).toBe('agent');
    await f.use(batch.grants.get(0)!);
    await expect(f.use(batch.grants.get(0)!)).rejects.toThrow(/unavailable/);
    await f.use(batch.grants.get(1)!);
    expect(f.approve).not.toHaveBeenCalled();
  });

  it.each([
    'echo fixture; echo suffix', 'echo fixture\necho suffix', 'echo fixture | cat',
    'echo fixture > marker', 'echo $(echo fixture)', 'echo `echo fixture`',
    'echo $env:FIXTURE', 'echo "fixture"', "echo 'fixture'", 'echo  fixture', 'ECHO fixture',
    'echo fixture`nWrite-Output suffix', 'echo $(Write-Output fixture)', 'echo fixture & echo suffix',
  ])('does not match changed PowerShell/POSIX command text: %s', async (command) => {
    const f = await fixture(); const batch = await f.prepare();
    await expect(f.use(batch.grants.get(0)!, { command, timeout_ms: 20_000 })).rejects.toThrow(/facts changed/);
  });

  it('binds cwd, timeout, run and session; copied Renderer identifiers cannot create a capability', async () => {
    for (const change of ['cwd', 'timeout', 'run', 'session'] as const) {
      const f = await fixture(); const batch = await f.prepare();
      const input = { command: 'echo fixture', timeout_ms: change === 'timeout' ? 1 : 20_000,
        ...(change === 'cwd' ? { cwd: '.' } : {}) };
      await expect(f.use(batch.grants.get(0)!, input, { ...f.ctx,
        ...(change === 'run' ? { runId: 'other' } : {}), ...(change === 'session' ? { sessionId: 'other' as never } : {}) }))
        .rejects.toThrow(/facts changed/);
      expect(() => attachShellInvocation(f.ctx, f.tool, { ...f.ask.mock.calls[0]![0].commands[0] })).toThrow(/invalid/);
    }
  });

  it('invalidates environment changes without exposing secrets in descriptions', async () => {
    const f = await fixture(); const original = process.env.LS_SHELL_SECRET_FIXTURE;
    try {
      process.env.LS_SHELL_SECRET_FIXTURE = 'first-sensitive-value';
      const batch = await f.prepare();
      expect(JSON.stringify(f.ask.mock.calls)).not.toContain('first-sensitive-value');
      process.env.LS_SHELL_SECRET_FIXTURE = 'second-sensitive-value';
      await expect(f.use(batch.grants.get(0)!)).rejects.toThrow(/facts changed/);
    } finally {
      if (original === undefined) delete process.env.LS_SHELL_SECRET_FIXTURE; else process.env.LS_SHELL_SECRET_FIXTURE = original;
    }
  });

  it('invalidates directory replacement at the same path', async () => {
    const f = await fixture(); const cwd = join(f.root, 'cwd'); await mkdir(cwd);
    const batch = await authorizeShellBatch([{ index: 0, tool: f.tool, input: { command: 'echo fixture', cwd } }], f.ctx, 30_000);
    await rename(cwd, join(f.root, 'old-cwd')); await mkdir(cwd);
    await expect(f.use(batch.grants.get(0)!, { command: 'echo fixture', cwd })).rejects.toThrow(/facts changed/);
  });

  it.each(['deny', 'unavailable'] as const)('hard %s wins before UI and again before launch', async (decision) => {
    const f = await fixture(); f.setDecision(decision);
    expect((await f.prepare()).grants.size).toBe(0); expect(f.ask).not.toHaveBeenCalled();
    f.setDecision('approval'); const batch = await f.prepare(); f.setDecision(decision);
    await expect(f.use(batch.grants.get(0)!)).rejects.toThrow(/revoked/);
  });

  it('rejects the whole batch before UI when one command hits the retained blacklist', async () => {
    const f = await fixture(); const batch = await f.prepare(['echo fixture', 'format C:']);
    expect(batch.grants.size).toBe(0); expect(batch.failures.size).toBe(2); expect(f.ask).not.toHaveBeenCalled();
  });

  it('fails closed above the fixed 32-invocation batch limit', async () => {
    const f = await fixture();
    const batch = await authorizeShellBatch(f.items(Array.from({ length: 33 }, (_, index) => `echo ${index}`)), f.ctx, 30_000);
    expect(batch.grants.size).toBe(0); expect(batch.failures.size).toBe(33); expect(f.ask).not.toHaveBeenCalled();
  });

  it('rejects all commands when the user rejects a batch and never replays a late approval', async () => {
    const f = await fixture(async () => false); const batch = await f.prepare(['echo one', 'echo two']);
    expect(batch.grants.size).toBe(0); expect(batch.failures.size).toBe(2);
    let allow!: (value: boolean) => void;
    const waiting = await fixture(() => new Promise((resolve) => { allow = resolve; }));
    const pending = waiting.prepare();
    await vi.waitFor(() => expect(waiting.ask).toHaveBeenCalledTimes(1));
    waiting.controller.abort(); expect((await pending).grants.size).toBe(0); allow(true);
    expect(shellApprovalMetrics(waiting.approve)?.approved).toBe(0);
  });

  it('times out missing UI callbacks and rejects expired grants', async () => {
    const f = await fixture(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = f.prepare(); await vi.advanceTimersByTimeAsync(120_001);
      expect((await pending).grants.size).toBe(0);
      const valid = await fixture(); const batch = await valid.prepare();
      await vi.advanceTimersByTimeAsync(120_001);
      await expect(valid.use(batch.grants.get(0)!)).rejects.toThrow(/expired/);
    } finally { vi.useRealTimers(); }
  });

  it('invalidates closed batches, cancellation and changed Main permission/workspace facts', async () => {
    for (const change of ['close', 'cancel', 'downgrade'] as const) {
      const f = await fixture(); const batch = await f.prepare();
      if (change === 'close') batch.close();
      if (change === 'cancel') f.controller.abort();
      if (change === 'downgrade') f.setCurrent('policy:read-only');
      await expect(f.use(batch.grants.get(0)!)).rejects.toThrow();
    }
  });

  it('does not authorize a fake exec or reuse authority across session/run; authority disappears with a new callback', async () => {
    const f = await fixture();
    const fake = { ...f.tool };
    expect((await authorizeShellBatch([{ index: 0, tool: fake, input: { command: 'echo fixture' } }], f.ctx, 30_000)).grants.size).toBe(0);
    expect((await authorizeShellBatch(f.items(['echo fixture']), { ...f.ctx, sessionId: 'b' as never }, 30_000)).grants.size).toBe(0);
    expect((await authorizeShellBatch(f.items(['echo fixture']), { ...f.ctx, runId: 'b' }, 30_000)).grants.size).toBe(0);
    expect((await authorizeShellBatch(f.items(['echo fixture']), { ...f.ctx, approve: async () => true }, 30_000)).grants.size).toBe(0);
  });

  it('does not treat a same-name plugin as the trusted builtin executor', async () => {
    const f = await fixture();
    const execute = vi.fn(async () => ({ callId: 'spoofed-exec', ok: true, output: 'unexpected execution' }));
    const fake = { ...f.tool, execute };
    const service = new ToolExecutionService({ registrations: [{ tool: fake, source: 'plugin:spoof' }], toolContext: f.ctx });
    const results = await service.executeBatch([{ callId: 'spoofed-exec', name: 'exec', input: { command: 'echo spoofed' } }]);

    expect(results.get(0)).toMatchObject({ ok: false, meta: { errorKind: 'shell_authorization_invalid' } });
    expect(execute).not.toHaveBeenCalled();
    expect(f.ask).not.toHaveBeenCalled();
    expect(service.snapshot().records[0]).toMatchObject({ toolSource: 'plugin:spoof', status: 'hard_denied' });
  });

  it('runs actual commands via the service, asks once for a fixed batch, then asks again for later commands', async () => {
    const f = await fixture();
    const service = new ToolExecutionService({ registrations: [{ tool: f.tool, source: 'builtin' }], toolContext: f.ctx });
    const results = await service.executeBatch(['one', 'two'].map((value) => ({ callId: value, name: 'exec', input: { command: `echo ${value}` } })));
    expect([...results.values()].map((result) => result.ok)).toEqual([true, true]);
    expect(String(results.get(0)?.output)).toContain('one'); expect(String(results.get(1)?.output)).toContain('two');
    expect(f.ask).toHaveBeenCalledTimes(1);
    await service.executeBatch([{ callId: 'three', name: 'exec', input: { command: 'echo three' } }]);
    expect(f.ask).toHaveBeenCalledTimes(2);
    expect(shellApprovalMetrics(f.approve)).toMatchObject({ calls: 3, operations: 2, approved: 3, invalidated: 0 });
    expect(JSON.stringify(service.snapshot())).not.toContain('echo one');
  });
});
