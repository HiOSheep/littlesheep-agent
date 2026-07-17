import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from './exec.js';
import type { ToolContext } from '@littlesheep/types';

const baseCtx: ToolContext = {
  sessionId: 's1' as never,
  runId: 'r1',
  cwd: process.cwd(),
};

describe('execTool approval gate', () => {
  it('blacklist denies (format)', async () => {
    const exec = createExecTool({ interactive: false });
    const result = await exec.execute({ command: 'format C:' }, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blacklist/);
  });

  it('blacklist denies (rm -rf /)', async () => {
    const exec = createExecTool({ interactive: false });
    const result = await exec.execute({ command: 'rm -rf /' }, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Approval denied.*blacklist/);
  });

  it('whitelist approves (echo)', async () => {
    const exec = createExecTool({ interactive: false });
    const result = await exec.execute({ command: 'echo littlesheep-test' }, baseCtx);
    expect(result.ok).toBe(true);
    const output = result.output as string;
    expect(output).toContain('littlesheep-test');
  });

  it('unknown command escalates; ctx.approve=true proceeds', async () => {
    const exec = createExecTool({ interactive: false });
    const ctx: ToolContext = {
      ...baseCtx,
      approve: async () => true,
    };
    const result = await exec.execute({ command: 'echo from-approve' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('from-approve');
  });

  it('unknown command escalates; ctx.approve=false denies', async () => {
    const exec = createExecTool({ interactive: false });
    const ctx: ToolContext = {
      ...baseCtx,
      approve: async () => false,
    };
    const result = await exec.execute({ command: 'some-unknown-cmd-xyz' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Approval denied/);
  });

  it('unknown command without approve callback denies', async () => {
    const exec = createExecTool({ interactive: false });
    const result = await exec.execute({ command: 'unknown-cmd-123' }, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Approval denied/);
  });

  it('captures non-zero exit code in meta', async () => {
    const exec = createExecTool({ interactive: false });
    // "exit 42" is not whitelisted → escalates; approve=true lets it run
    const ctx: ToolContext = { ...baseCtx, approve: async () => true };
    const result = await exec.execute({ command: 'exit 42' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exit code 42/);
    const meta = result.meta as { exitCode: number };
    expect(meta.exitCode).toBe(42);
  });

  it('respects custom approvalConfig', async () => {
    const exec = createExecTool({
      interactive: false,
      approvalConfig: {
        whitelist: [],
        blacklist: [],
        approvalMode: 'auto-approve',
      },
    });
    // auto-approve mode bypasses escalation for unknown commands
    const result = await exec.execute({ command: 'echo custom-config' }, baseCtx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('custom-config');
  });

  it('respects cwd option', async () => {
    const exec = createExecTool({ interactive: false });
    // pwd / Get-Location — both whitelisted? No. Use echo which is whitelisted.
    const result = await exec.execute(
      { command: 'echo cwd-test', cwd: process.cwd() },
      baseCtx,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects mutating commands inside a protected core root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-core-exec-'));
    const file = join(root, 'changed.txt');
    try {
      const exec = createExecTool({
        interactive: false,
        approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'auto-approve' },
      });
      const script = `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'changed')`;
      const result = await exec.execute(
        { command: `node -e ${JSON.stringify(script)}`, cwd: root },
        { ...baseCtx, protectedWriteRoots: [root] },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/core source is read-only/i);
      await expect(stat(file)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not start a mutating command when the workspace preimage fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-exec-checkpoint-'));
    const file = join(root, 'changed.txt');
    try {
      const exec = createExecTool({
        interactive: false,
        approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'auto-approve' },
      });
      const beforeWorkspaceMutation = vi.fn(async () => { throw new Error('checkpoint unavailable'); });
      const script = `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'changed')`;
      const result = await exec.execute(
        { command: `node -e ${JSON.stringify(script)}`, cwd: root },
        {
          ...baseCtx,
          cwd: root,
          versioning: { beforeFileMutation: vi.fn(), beforeWorkspaceMutation },
        },
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/checkpoint unavailable/);
      expect(beforeWorkspaceMutation).toHaveBeenCalledWith(root);
      await expect(stat(file)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('has requiresApproval=true', () => {
    const exec = createExecTool({ interactive: false });
    expect(exec.requiresApproval).toBe(true);
  });
});
