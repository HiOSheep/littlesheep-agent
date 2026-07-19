import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editTool } from './edit.js';
import type { ToolContext } from '@littlesheep/types';

const approvedCtx: ToolContext = {
  sessionId: 's1' as never,
  runId: 'r1',
  cwd: process.cwd(),
  approve: async () => true,
};

const deniedCtx: ToolContext = {
  sessionId: 's1' as never,
  runId: 'r1',
  cwd: process.cwd(),
  approve: async () => false,
};

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ls-edit-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('editTool', () => {
  it('replaces a unique string exactly', async () => {
    const file = join(tmpDir, 'unique.txt');
    await writeFile(file, 'before TARGET after', 'utf8');
    const result = await editTool.execute(
      { file_path: file, old_string: 'TARGET', new_string: 'REPLACED' },
      approvedCtx,
    );
    expect(result.ok).toBe(true);
    const content = await readFile(file, 'utf8');
    expect(content).toBe('before REPLACED after');
  });

  it('fails when old_string is not found', async () => {
    const file = join(tmpDir, 'nochange.txt');
    await writeFile(file, 'hello world', 'utf8');
    const result = await editTool.execute(
      { file_path: file, old_string: 'NONEXISTENT', new_string: 'x' },
      approvedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('fails when old_string is not unique', async () => {
    const file = join(tmpDir, 'dup.txt');
    await writeFile(file, 'aaa aaa aaa', 'utf8');
    const result = await editTool.execute(
      { file_path: file, old_string: 'aaa', new_string: 'b' },
      approvedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not unique/);
  });

  it('fails when approval is denied', async () => {
    const file = join(tmpDir, 'denied.txt');
    await writeFile(file, 'original', 'utf8');
    const result = await editTool.execute(
      { file_path: file, old_string: 'original', new_string: 'changed' },
      deniedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Approval denied/);
    // file unchanged
    const content = await readFile(file, 'utf8');
    expect(content).toBe('original');
  });

  it('does not probe an unauthorized missing path before approval', async () => {
    const approve = vi.fn(async () => false);
    const result = await editTool.execute(
      { file_path: join(tmpDir, 'outside-missing.txt'), old_string: 'x', new_string: 'y' },
      {
        ...deniedCtx,
        containerRoot: join(tmpDir, 'container'),
        permissionMode: 'research',
        approve,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Approval denied/);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('fails for missing file', async () => {
    const result = await editTool.execute(
      { file_path: join(tmpDir, 'missing.txt'), old_string: 'x', new_string: 'y' },
      approvedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/File not found/);
  });

  it('rejects edits inside a protected core root before approval', async () => {
    const root = tmpDir;
    const file = join(root, 'protected-source.ts');
    await writeFile(file, 'original', 'utf8');
    const result = await editTool.execute(
      { file_path: file, old_string: 'original', new_string: 'changed' },
      { ...approvedCtx, protectedWriteRoots: [root] },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/core source is read-only/i);
    expect(await readFile(file, 'utf8')).toBe('original');
  });

  it('keeps the original file when the preimage checkpoint fails', async () => {
    const file = join(tmpDir, 'checkpoint-failure.txt');
    await writeFile(file, 'original', 'utf8');
    const result = await editTool.execute(
      { file_path: file, old_string: 'original', new_string: 'changed' },
      {
        ...approvedCtx,
        versioning: {
          beforeFileMutation: vi.fn(async () => { throw new Error('checkpoint unavailable'); }),
          beforeWorkspaceMutation: vi.fn(),
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/checkpoint unavailable/);
    expect(await readFile(file, 'utf8')).toBe('original');
  });

  it('requires approval', () => {
    expect(editTool.requiresApproval).toBe(true);
  });
});
