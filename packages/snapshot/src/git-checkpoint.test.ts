import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCheckpointCoordinator } from './git-checkpoint.js';

describe('GitCheckpointCoordinator', () => {
  it('links data and workspace commits and rolls back both without touching untracked files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-checkpoint-'));
    try {
      const dataRoot = join(root, 'data');
      const workspace = join(root, 'workspace');
      await mkdir(join(dataRoot, 'memory'), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(dataRoot, 'MEMORY.md'), 'memory-v1', 'utf8');
      await writeFile(join(workspace, 'result.txt'), 'result-v1', 'utf8');

      const coordinator = new GitCheckpointCoordinator({ dataRoot });
      await coordinator.initialize();

      const first = await coordinator.beginRun({ runId: 'run-1', workspaceRoot: workspace });
      await first.beforeFileMutation(join(workspace, 'result.txt'));
      await writeFile(join(workspace, 'result.txt'), 'result-v2', 'utf8');
      await writeFile(join(dataRoot, 'MEMORY.md'), 'memory-v2', 'utf8');
      const firstSummary = await first.complete({ sessionId: 'session-1' });

      const second = await coordinator.beginRun({ runId: 'run-2', workspaceRoot: workspace });
      await second.beforeFileMutation(join(workspace, 'result.txt'));
      await writeFile(join(workspace, 'result.txt'), 'result-v3', 'utf8');
      await writeFile(join(dataRoot, 'MEMORY.md'), 'memory-v3', 'utf8');
      await writeFile(join(workspace, 'untracked-user-file.txt'), 'must survive rollback', 'utf8');
      await second.complete({ sessionId: 'session-2' });

      const rollback = await coordinator.rollback(firstSummary.id);

      expect(rollback.reason).toBe('rollback');
      expect(await readFile(join(dataRoot, 'MEMORY.md'), 'utf8')).toBe('memory-v2');
      expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('result-v2');
      expect(await readFile(join(workspace, 'untracked-user-file.txt'), 'utf8')).toBe('must survive rollback');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('can roll back a run to its preimage, including a file that did not exist before the run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-checkpoint-preimage-'));
    try {
      const dataRoot = join(root, 'data');
      const workspace = join(root, 'workspace');
      await mkdir(dataRoot, { recursive: true });
      await mkdir(workspace, { recursive: true });
      const coordinator = new GitCheckpointCoordinator({ dataRoot });
      await coordinator.initialize();
      const run = await coordinator.beginRun({ runId: 'run-new-file', workspaceRoot: workspace });
      await run.beforeFileMutation(join(workspace, 'created.txt'));
      await writeFile(join(workspace, 'created.txt'), 'created by LS', 'utf8');
      const summary = await run.complete();

      await coordinator.rollback(summary.id, { position: 'before' });

      await expect(readFile(join(workspace, 'created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
