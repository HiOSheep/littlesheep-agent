import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editTool } from './edit.js';
import { readTool } from './read.js';
import type { ToolContext } from '@littlesheep/types';
import { createInMemoryFileObservationPort } from '../file-observation.js';

const approvedCtx: ToolContext = {
  sessionId: 's1' as never,
  runId: 'r1',
  cwd: process.cwd(),
  approve: async () => true,
};

/** An approved context that also carries a real observation port. */
function observedCtx(): ToolContext {
  return { ...approvedCtx, observation: createInMemoryFileObservationPort() };
}

/** Read the file the way the model would, so the following edit is allowed. */
async function readFirst(ctx: ToolContext, file: string, options: { offset?: number; limit?: number } = {}): Promise<void> {
  const result = await readTool.execute({ file_path: file, ...options }, ctx);
  expect(result.ok).toBe(true);
}

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
    const ctx = observedCtx();
    await writeFile(file, 'before TARGET after', 'utf8');
    await readFirst(ctx, file);
    const result = await editTool.execute(
      { file_path: file, old_string: 'TARGET', new_string: 'REPLACED' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const content = await readFile(file, 'utf8');
    expect(content).toBe('before REPLACED after');
  });

  it('fails when old_string is not found', async () => {
    const file = join(tmpDir, 'nochange.txt');
    const ctx = observedCtx();
    await writeFile(file, 'hello world', 'utf8');
    await readFirst(ctx, file);
    const result = await editTool.execute(
      { file_path: file, old_string: 'NONEXISTENT', new_string: 'x' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('fails when old_string is not unique', async () => {
    const file = join(tmpDir, 'dup.txt');
    const ctx = observedCtx();
    await writeFile(file, 'aaa aaa aaa', 'utf8');
    await readFirst(ctx, file);
    const result = await editTool.execute(
      { file_path: file, old_string: 'aaa', new_string: 'b' },
      ctx,
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
    const ctx: ToolContext = {
      ...observedCtx(),
      versioning: {
        beforeFileMutation: vi.fn(async () => { throw new Error('checkpoint unavailable'); }),
        beforeWorkspaceMutation: vi.fn(),
      },
    };
    // The observation must be valid, otherwise the refusal would happen before
    // the checkpoint and this test would no longer exercise the checkpoint path.
    await readFirst(ctx, file);
    const result = await editTool.execute(
      { file_path: file, old_string: 'original', new_string: 'changed' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/checkpoint unavailable/);
    expect(await readFile(file, 'utf8')).toBe('original');
  });

  it('requires approval', () => {
    expect(editTool.requiresApproval).toBe(true);
  });

  // RS-02: an edit is only allowed against a version this session read.
  describe('observed-version guard', () => {
    it('refuses to edit a file the session never read', async () => {
      const file = join(tmpDir, 'unread-edit.txt');
      await writeFile(file, 'original', 'utf8');

      const result = await editTool.execute(
        { file_path: file, old_string: 'original', new_string: 'changed' },
        observedCtx(),
      );

      expect(result.ok).toBe(false);
      expect(result.meta).toMatchObject({ errorKind: 'observation_missing' });
      expect(await readFile(file, 'utf8')).toBe('original');
    });

    it('refuses when the host does not track observations at all', async () => {
      const file = join(tmpDir, 'no-port-edit.txt');
      await writeFile(file, 'original', 'utf8');

      const result = await editTool.execute(
        { file_path: file, old_string: 'original', new_string: 'changed' },
        approvedCtx,
      );

      expect(result.ok).toBe(false);
      expect(result.meta).toMatchObject({ errorKind: 'observation_unsupported' });
      expect(await readFile(file, 'utf8')).toBe('original');
    });

    it('refuses to edit after the file changed elsewhere', async () => {
      const file = join(tmpDir, 'drift-edit.txt');
      const ctx = observedCtx();
      await writeFile(file, 'original text', 'utf8');
      await readFirst(ctx, file);
      await writeFile(file, 'changed elsewhere', 'utf8');

      const result = await editTool.execute(
        { file_path: file, old_string: 'changed elsewhere', new_string: 'mine' },
        ctx,
      );

      expect(result.ok).toBe(false);
      expect(result.meta).toMatchObject({ errorKind: 'observation_stale' });
      expect(await readFile(file, 'utf8')).toBe('changed elsewhere');
    });

    it('allows an edit inside the range of a partial read', async () => {
      const file = join(tmpDir, 'partial-edit.txt');
      const ctx = observedCtx();
      await writeFile(file, 'line1\nline2\nline3\n', 'utf8');
      await readFirst(ctx, file, { offset: 2, limit: 2 });

      const result = await editTool.execute(
        { file_path: file, old_string: 'line3', new_string: 'LINE3' },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(await readFile(file, 'utf8')).toBe('line1\nline2\nLINE3\n');
    });

    it('refuses an edit outside the range of a partial read', async () => {
      const file = join(tmpDir, 'partial-refused.txt');
      const ctx = observedCtx();
      await writeFile(file, 'line1\nline2\nline3\n', 'utf8');
      await readFirst(ctx, file, { offset: 2, limit: 1 });

      const result = await editTool.execute(
        { file_path: file, old_string: 'line1', new_string: 'LINE1' },
        ctx,
      );

      expect(result.ok).toBe(false);
      expect(result.meta).toMatchObject({ errorKind: 'observation_missing' });
      expect(result.error).toMatch(/outside the lines that were read/);
      expect(await readFile(file, 'utf8')).toBe('line1\nline2\nline3\n');
    });

    it('requires a fresh read after a successful edit', async () => {
      const file = join(tmpDir, 'one-shot-edit.txt');
      const ctx = observedCtx();
      await writeFile(file, 'original', 'utf8');
      await readFirst(ctx, file);
      expect((await editTool.execute(
        { file_path: file, old_string: 'original', new_string: 'first' },
        ctx,
      )).ok).toBe(true);

      const second = await editTool.execute(
        { file_path: file, old_string: 'first', new_string: 'second' },
        ctx,
      );

      expect(second.ok).toBe(false);
      expect(second.meta).toMatchObject({ errorKind: 'observation_missing' });
      expect(await readFile(file, 'utf8')).toBe('first');
    });
  });
});
