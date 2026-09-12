import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTool } from './write.js';
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

  it('overwrites existing file', async () => {
    const file = join(tmpDir, 'overwrite.txt');
    await writeTool.execute({ file_path: file, content: 'v1' }, approvedCtx);
    await writeTool.execute({ file_path: file, content: 'v2' }, approvedCtx);
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
      await writeTool.execute({ file_path: file, content: 'second version' }, approvedCtx);
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
