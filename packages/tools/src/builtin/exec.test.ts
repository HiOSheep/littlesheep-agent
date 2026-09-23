import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecTool } from './exec.js';
import { readTool } from './read.js';
import {
  describeToolAccess,
  resolvePermissionDecision,
  shouldRequestPermissionApproval,
} from '@littlesheep/safety';
import type { ToolContext } from '@littlesheep/types';
import { createInMemoryFileObservationPort } from '../file-observation.js';

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
      // The refusal names itself so the loop treats it as an authoritative
      // boundary instead of an execution failure the model may work around.
      expect(result.meta?.errorKind).toBe('core_source_read_only');
      expect(result.error).toContain('Write into a writable workspace');
      await expect(stat(file)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // CE-05: reading a protected root is allowed; only the probe form was missing.
  it('answers existence and listing questions about a protected root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-core-read-'));
    const nested = join(root, 'with space');
    const file = join(nested, 'notes.txt');
    try {
      await mkdir(nested, { recursive: true });
      await writeFile(file, 'hello', 'utf8');
      const exec = createExecTool({
        interactive: false,
        approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'auto-approve' },
      });
      const protectedCtx: ToolContext = { ...baseCtx, cwd: root, protectedWriteRoots: [root] };

      const list = await exec.execute({ command: `Get-ChildItem '${nested}'` }, protectedCtx);
      expect(list.ok, list.error).toBe(true);
      expect(String(list.output)).toContain('notes.txt');

      const exists = await exec.execute({ command: `Test-Path -LiteralPath '${file}'` }, protectedCtx);
      expect(exists.ok, exists.error).toBe(true);
      expect(String(exists.output)).toMatch(/True/i);

      const missing = await exec.execute({ command: `Test-Path -LiteralPath '${join(nested, 'nope.txt')}'` }, protectedCtx);
      expect(missing.ok, missing.error).toBe(true);
      expect(String(missing.output)).toMatch(/False/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still refuses a composed probe inside a protected root', async () => {    const root = await mkdtemp(join(tmpdir(), 'ls-core-compose-'));
    try {
      const exec = createExecTool({
        interactive: false,
        approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'auto-approve' },
      });
      const protectedCtx: ToolContext = { ...baseCtx, cwd: root, protectedWriteRoots: [root] };
      const attack = join(root, 'created.txt');

      for (const command of [
        `Test-Path '${root}'; New-Item -ItemType File '${attack}'`,
        `Test-Path '${root}' && New-Item -ItemType File '${attack}'`,
        `Get-ChildItem '${root}' > '${attack}'`,
        `mkdir '${attack}'`,
      ]) {
        const result = await exec.execute({ command }, protectedCtx);
        expect(result.ok, command).toBe(false);
        expect(result.meta?.errorKind).toBe('core_source_read_only');
      }
      await expect(stat(attack)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // CE-05: a read-only command shape is a statement about the *effect*, not about
  // the container. It must not classify an outside directory as inside, and it
  // must not waive the approval a research or restricted run still owes.
  it('keeps the container boundary and approval decision unchanged for read-only commands', () => {
    const containerRoot = join(tmpdir(), 'ls-container');
    const outside = join(tmpdir(), 'ls-outside-elsewhere');
    const context = { cwd: containerRoot, containerRoot };

    const inside = describeToolAccess('exec', { command: `Get-ChildItem '${containerRoot}'` }, context);
    const beyond = describeToolAccess('exec', { command: `Test-Path -LiteralPath '${outside}'` }, context);
    const opaque = describeToolAccess('exec', { command: `node -e "console.log(1)"` }, context);

    expect(inside.boundary).toBe('inside');
    expect(beyond.boundary).toBe('outside');
    // A whitelisted read-only shape is still an outside read that research mode
    // must approve, and an opaque command stays unknown-boundary as before.
    expect(shouldRequestPermissionApproval('research', beyond)).toBe(true);
    expect(shouldRequestPermissionApproval('research', inside)).toBe(true);
    expect(opaque.boundary).toBe('unknown');
    expect(resolvePermissionDecision('full', beyond)).toBe('allow');
    expect(resolvePermissionDecision('restricted', inside)).toBe('approval');
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

  it('does not request the same interactive approval twice', async () => {
    const approve = vi.fn(async () => true);
    const exec = createExecTool({
      interactive: false,
      approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'interactive' },
    });

    const result = await exec.execute(
      { command: 'echo service-approved' },
      { ...baseCtx, approve, approvalGranted: true },
    );

    expect(result.ok).toBe(true);
    expect(approve).not.toHaveBeenCalled();
  });

  it('does not re-prompt full access for an outside command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-full-access-exec-'));
    const approve = vi.fn(async () => false);
    try {
      const exec = createExecTool({
        interactive: false,
        approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'interactive' },
      });
      const result = await exec.execute(
        { command: 'echo full-access-outside', cwd: root },
        {
          ...baseCtx,
          cwd: root,
          containerRoot: join(root, 'container'),
          permissionMode: 'full',
          approve,
        },
      );

      expect(result.ok).toBe(true);
      expect(result.output).toContain('full-access-outside');
      expect(approve).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds retained stdout while preserving total output evidence', async () => {
    const exec = createExecTool({
      interactive: false,
      approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'auto-approve' },
    });
    const command = process.platform === 'win32'
      ? "$chunk = 'x' * 4096; 1..40 | ForEach-Object { [Console]::Out.Write($chunk) }"
      : "i=0; while [ $i -lt 40 ]; do printf '%04096d' 0; i=$((i+1)); done";

    const result = await exec.execute({ command, timeout_ms: 30_000 }, baseCtx);
    const meta = result.meta as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.sanitized).toBe(true);
    expect(String(result.output).length).toBeLessThan(20_000);
    expect(meta.captureTruncated).toBe(true);
    expect(Number(meta.stdoutLen)).toBeGreaterThan(64 * 1024);
    expect(Number(meta.stdoutRetainedChars)).toBeLessThanOrEqual(64 * 1024);
  });

  it('terminates a timed-out shell process and reports closed process evidence', async () => {
    const exec = createExecTool({
      interactive: false,
      approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'auto-approve' },
    });
    const command = process.platform === 'win32'
      ? 'Start-Sleep -Seconds 30'
      : 'sleep 30';
    const startedAt = Date.now();

    const result = await exec.execute({ command, timeout_ms: 100 }, baseCtx);
    const meta = result.meta as Record<string, unknown>;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    expect(meta.timedOut).toBe(true);
    expect(meta.processClosed).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

// RS-04: an opaque command invalidates what the model believed it had read.
describe('execTool observation invalidation', () => {
  async function scenario(): Promise<{ dir: string; ctx: ToolContext; file: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'ls-exec-observation-'));
    const file = join(dir, 'notes.txt');
    await writeFile(file, 'original', 'utf8');
    const ctx: ToolContext = {
      ...baseCtx,
      cwd: dir,
      observation: createInMemoryFileObservationPort(),
      approve: async () => true,
    };
    await readTool.execute({ file_path: file }, ctx);
    return { dir, ctx, file };
  }

  it('drops the observation after a command that rewrote the file', async () => {
    const { dir, ctx, file } = await scenario();
    try {
      const exec = createExecTool({ interactive: false, approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'auto-approve' } });
      const command = process.platform === 'win32'
        ? `Set-Content -LiteralPath '${file}' -Value 'rewritten by shell'`
        : `sh -c "printf 'rewritten by shell' > '${file}'"`;
      expect((await exec.execute({ command }, ctx)).ok).toBe(true);

      const lookup = ctx.observation!.lookup(file);
      expect(lookup.ok).toBe(false);
      if (!lookup.ok) expect(lookup.errorKind).toBe('observation_missing');
      expect(await readFile(file, 'utf8')).toContain('rewritten by shell');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops the observation even when the command never touched the file', async () => {
    const { dir, ctx, file } = await scenario();
    try {
      const exec = createExecTool({ interactive: false, approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'auto-approve' } });
      await exec.execute({ command: 'echo harmless' }, ctx);

      // The scope of a shell command cannot be proven, so the safe answer is
      // that the model has to read the file again.
      expect(ctx.observation!.lookup(file).ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops the observation when the command exits non-zero', async () => {
    const { dir, ctx, file } = await scenario();
    try {
      const exec = createExecTool({ interactive: false, approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'auto-approve' } });
      const command = process.platform === 'win32' ? 'exit 3' : 'exit 3';
      expect((await exec.execute({ command }, ctx)).ok).toBe(false);

      expect(ctx.observation!.lookup(file).ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the observation when approval is denied before the process starts', async () => {
    const { dir, ctx, file } = await scenario();
    try {
      const exec = createExecTool({ interactive: false });
      const result = await exec.execute({ command: 'format C:' }, ctx);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/blacklist/);
      // Nothing ran, so the read the model already has is still valid.
      expect(ctx.observation!.lookup(file).ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops the observation when the command is terminated by timeout', async () => {
    const { dir, ctx, file } = await scenario();
    try {
      const exec = createExecTool({ interactive: false, approvalConfig: { whitelist: [], blacklist: [], approvalMode: 'auto-approve' } });
      const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
      const result = await exec.execute({ command, timeout_ms: 100 }, ctx);

      expect(result.ok).toBe(false);
      // Whether the process is already closed or still being killed, the
      // observation is unusable either way.
      expect(ctx.observation!.lookup(file).ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
