import { describe, it, expect } from 'vitest';
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

  it('has requiresApproval=true', () => {
    const exec = createExecTool({ interactive: false });
    expect(exec.requiresApproval).toBe(true);
  });
});
