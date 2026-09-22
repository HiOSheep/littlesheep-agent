import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTool } from './write.js';
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

/** Read a file the way the model would, so the following write is allowed. */
async function readFirst(ctx: ToolContext, file: string): Promise<void> {
  const result = await readTool.execute({ file_path: file }, ctx);
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
  tmpDir = await mkdtemp(join(tmpdir(), 'ls-write-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('writeTool', () => {
  it('writes content to a new file', async () => {
    const file = join(tmpDir, 'new.txt');
    const result = await writeTool.execute(
      { file_path: file, content: 'hello content' },
      approvedCtx,
    );
    expect(result.ok).toBe(true);
    const content = await readFile(file, 'utf8');
    expect(content).toBe('hello content');
  });

  it('overwrites a file the session has read in full', async () => {
    const file = join(tmpDir, 'overwrite.txt');
    const ctx = observedCtx();
    await writeTool.execute({ file_path: file, content: 'v1' }, ctx);
    await readFirst(ctx, file);
    const result = await writeTool.execute({ file_path: file, content: 'v2' }, ctx);
    expect(result.ok).toBe(true);
    const content = await readFile(file, 'utf8');
    expect(content).toBe('v2');
  });

  it('creates nested directories', async () => {
    const file = join(tmpDir, 'a', 'b', 'c', 'deep.txt');
    const result = await writeTool.execute(
      { file_path: file, content: 'deep' },
      approvedCtx,
    );
    expect(result.ok).toBe(true);
    const content = await readFile(file, 'utf8');
    expect(content).toBe('deep');
  });

  it('fails when approval is denied', async () => {
    const file = join(tmpDir, 'denied.txt');
    const result = await writeTool.execute(
      { file_path: file, content: 'no' },
      deniedCtx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Approval denied/);
    await expect(stat(file)).rejects.toThrow();
  });

  it('rejects writes inside a protected core root before approval', async () => {
    const file = join(tmpDir, 'core', 'source.ts');
    const result = await writeTool.execute(
      { file_path: file, content: 'changed' },
      { ...approvedCtx, protectedWriteRoots: [join(tmpDir, 'core')] },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/core source is read-only/i);
    await expect(stat(file)).rejects.toThrow();
  });

  it('fails closed when the preimage checkpoint cannot be created', async () => {
    const file = join(tmpDir, 'checkpoint-failure.txt');
    const beforeFileMutation = vi.fn(async () => { throw new Error('checkpoint unavailable'); });
    const result = await writeTool.execute(
      { file_path: file, content: 'must not be written' },
      {
        ...approvedCtx,
        versioning: { beforeFileMutation, beforeWorkspaceMutation: vi.fn() },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/checkpoint unavailable/);
    expect(beforeFileMutation).toHaveBeenCalledWith(file);
    await expect(stat(file)).rejects.toThrow();
  });

  it('requires approval', () => {
    expect(writeTool.requiresApproval).toBe(true);
  });

  // RS-02: overwriting an existing file requires an observation of that version.
  describe('observed-version guard', () => {
    it('refuses to overwrite a file the session never read', async () => {
      const file = join(tmpDir, 'unread.txt');
      await writeFile(file, 'original', 'utf8');
      const ctx = observedCtx();

      const result = await writeTool.execute({ file_path: file, content: 'replacement' }, ctx);

      expect(result.ok).toBe(false);
      expect(result.meta).toMatchObject({ errorKind: 'observation_missing' });
      expect(await readFile(file, 'utf8')).toBe('original');
    });

    it('refuses when the host does not track observations at all', async () => {
      const file = join(tmpDir, 'no-port.txt');
      await writeFile(file, 'original', 'utf8');

      const result = await writeTool.execute({ file_path: file, content: 'replacement' }, approvedCtx);

      expect(result.ok).toBe(false);
      expect(result.meta).toMatchObject({ errorKind: 'observation_unsupported' });
      expect(await readFile(file, 'utf8')).toBe('original');
    });

    it('refuses to overwrite after an external change of the same size', async () => {
      const file = join(tmpDir, 'same-size.txt');
      const ctx = observedCtx();
      await writeFile(file, 'aaaa', 'utf8');
      await readFirst(ctx, file);
      // Same byte count, same fast filters: only the content hash can tell.
      await writeFile(file, 'bbbb', 'utf8');

      const result = await writeTool.execute({ file_path: file, content: 'cccc' }, ctx);

      expect(result.ok).toBe(false);
      expect(result.meta).toMatchObject({ errorKind: 'observation_stale' });
      expect(await readFile(file, 'utf8')).toBe('bbbb');
    });

    it('requires a fresh read after a successful overwrite', async () => {
      const file = join(tmpDir, 'one-shot.txt');
      const ctx = observedCtx();
      await writeFile(file, 'v1', 'utf8');
      await readFirst(ctx, file);
      expect((await writeTool.execute({ file_path: file, content: 'v2' }, ctx)).ok).toBe(true);

      const second = await writeTool.execute({ file_path: file, content: 'v3' }, ctx);

      expect(second.ok).toBe(false);
      expect(second.meta).toMatchObject({ errorKind: 'observation_missing' });
      expect(await readFile(file, 'utf8')).toBe('v2');
    });

    it('refuses a partial observation for a whole-file overwrite', async () => {
      const file = join(tmpDir, 'partial.txt');
      const ctx = observedCtx();
      await writeFile(file, 'line1\nline2\nline3\n', 'utf8');
      await expect(readTool.execute({ file_path: file, offset: 1, limit: 1 }, ctx)).resolves.toMatchObject({ ok: true });

      const result = await writeTool.execute({ file_path: file, content: 'replacement' }, ctx);

      expect(result.ok).toBe(false);
      expect(result.meta).toMatchObject({ errorKind: 'observation_missing' });
      expect(result.error).toMatch(/part of the file/);
      expect(await readFile(file, 'utf8')).toBe('line1\nline2\nline3\n');
    });

    it('never overwrites a file that appears between validation and the create', async () => {
      const file = join(tmpDir, 'raced.txt');
      const ctx: ToolContext = {
        ...observedCtx(),
        versioning: {
          // Stands in for another writer winning the race: the path is created
          // after the existence check but before the exclusive create.
          beforeFileMutation: async (path: string) => {
            await writeFile(path, 'other writer', 'utf8');
          },
          beforeWorkspaceMutation: async () => {},
        },
      };

      const result = await writeTool.execute({ file_path: file, content: 'mine' }, ctx);

      expect(result.ok).toBe(false);
      expect(result.meta).toMatchObject({ errorKind: 'target_exists' });
      expect(await readFile(file, 'utf8')).toBe('other writer');
    });

    it('still creates a brand-new file without any observation', async () => {
      const file = join(tmpDir, 'brand-new.txt');
      const ctx = observedCtx();

      const result = await writeTool.execute({ file_path: file, content: 'fresh' }, ctx);

      expect(result.ok).toBe(true);
      expect(await readFile(file, 'utf8')).toBe('fresh');
    });
  });

  describe('effect reconciliation', () => {
    function effectFor(reconciliationKey: unknown) {
      return {
        effectId: 'effect-write',
        idempotencyKey: 'tool:write:hash',
        toolName: 'write',
        effectKind: 'local_mutation',
        status: 'planned',
        intentEventId: 'event-intent',
        reconciliationKey,
      } as never;
    }

    it('declares a bounded key with the target path and content digest', () => {
      const file = join(tmpDir, 'reconcile-key.txt');
      const key = writeTool.reconciliationKey!({ file_path: file, content: 'reconcile me' });
      expect(key).toMatchObject({ path: file, bytes: 12 });
      expect((key as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(writeTool.reconciliationKey!({ file_path: 42 })).toBeUndefined();
    });

    it('reports the effect as succeeded when the target matches the intended bytes', async () => {
      const file = join(tmpDir, 'reconcile-ok.txt');
      const content = 'reconciled content';
      await writeTool.execute({ file_path: file, content }, approvedCtx);
      const outcome = await writeTool.reconcileEffect!(
        effectFor(writeTool.reconciliationKey!({ file_path: file, content })),
        { sessionId: 's1', runId: 'r1', authorizeRead: async () => true },
      );
      expect(outcome).toMatchObject({ known: true, status: 'succeeded' });
      expect((outcome as { evidenceRef?: string }).evidenceRef).toMatch(/^write:[0-9a-f]{12}$/);
    });

    it('keeps a missing target unknown because a completed write may have been removed', async () => {
      const file = join(tmpDir, 'reconcile-missing.txt');
      const outcome = await writeTool.reconcileEffect!(
        effectFor(writeTool.reconciliationKey!({ file_path: file, content: 'never written' })),
        { sessionId: 's1', runId: 'r1', authorizeRead: async () => true },
      );
      expect(outcome).toMatchObject({ known: false, reason: expect.stringContaining('missing') });
    });

    it('stays unknown when the target was changed by someone else', async () => {
      const file = join(tmpDir, 'reconcile-drift.txt');
      await writeTool.execute({ file_path: file, content: 'first version' }, approvedCtx);
      // Someone outside LS rewrites the file; reconciliation must not claim the
      // intended write is present just because the path exists.
      await writeFile(file, 'second version', 'utf8');
      const outcome = await writeTool.reconcileEffect!(
        effectFor(writeTool.reconciliationKey!({ file_path: file, content: 'first version' })),
        { sessionId: 's1', runId: 'r1', authorizeRead: async () => true },
      );
      expect(outcome).toMatchObject({ known: false });
      expect((outcome as { reason?: string }).reason).toMatch(/differs/);
    });

    it('stays unknown without a bounded key or for a relative target', async () => {
      expect(await writeTool.reconcileEffect!(effectFor(undefined), { sessionId: 's1', runId: 'r1' }))
        .toMatchObject({ known: false, reason: expect.stringContaining('no bounded reconciliation key') });
      expect(await writeTool.reconcileEffect!(
        effectFor({ path: 'relative/file.txt', sha256: 'a'.repeat(64) }),
        { sessionId: 's1', runId: 'r1' },
      )).toMatchObject({ known: false, reason: expect.stringContaining('absolute path') });
    });

    it('does not inspect even matching files without current host authorization', async () => {
      const file = join(tmpDir, 'private.txt');
      await writeTool.execute({ file_path: file, content: 'private' }, approvedCtx);
      const effect = effectFor(writeTool.reconciliationKey!({ file_path: file, content: 'private' }));
      for (const authorizeRead of [undefined, vi.fn(async () => false), vi.fn(async () => { throw new Error('denied'); })]) {
        expect(await writeTool.reconcileEffect!(effect, { sessionId: 's1', runId: 'r1', authorizeRead }))
          .toMatchObject({ known: false });
        if (authorizeRead) expect(authorizeRead).toHaveBeenCalledWith(file);
      }
    });
  });
});
