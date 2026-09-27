import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitCheckpointCoordinator } from './git-checkpoint.js';

describe('GitCheckpointCoordinator', () => {
  // The preimage commit is the largest single cost before a run reaches the provider (measured: 448–563 ms of
  // a ~915 ms wait for the first token). A run that changes nothing must not pay it again — but a run that
  // changed anything must still get a real commit, because that commit is the rollback point.
  it('reuses the previous preimage when nothing changed, and commits again when something did', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-preimage-'));
    const previousSwitch = process.env['LITTLESHEEP_BOOTSTRAP_TIMING'];
    const marks: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      marks.push(String(args[0]));
    });
    process.env['LITTLESHEEP_BOOTSTRAP_TIMING'] = '1';
    try {
      const dataRoot = join(root, 'data');
      const workspace = join(root, 'workspace');
      await mkdir(join(dataRoot, 'memory'), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(dataRoot, 'MEMORY.md'), 'memory-v1', 'utf8');

      const coordinator = new GitCheckpointCoordinator({ dataRoot });
      const first = await coordinator.beginRun({ runId: 'run-1', workspaceRoot: workspace });
      await first.complete({ sessionId: 'session-1' });

      // Nothing changed between the two runs, so the second reuses the first preimage instead of committing
      // an identical tree. The mark is the observable: it is emitted where the decision is made.
      const beforeSecondRun = marks.length;
      const unchanged = await coordinator.beginRun({ runId: 'run-2', workspaceRoot: workspace });
      const unchangedSummary = await unchanged.complete({ sessionId: 'session-2' });
      // Scoped to this run's own marks: the other cases in this file start coordinators too.
      const secondRunMarks = marks.slice(beforeSecondRun);
      expect(secondRunMarks.some((line) => line.includes('"preimage-reused"'))).toBe(true);
      expect(secondRunMarks.some((line) => line.includes('"preimage-committed"'))).toBe(false);

      // A content change must produce a new preimage; the reuse must not hide it.
      await writeFile(join(dataRoot, 'MEMORY.md'), 'memory-v2', 'utf8');
      const beforeThirdRun = marks.length;
      const changed = await coordinator.beginRun({ runId: 'run-3', workspaceRoot: workspace });
      await writeFile(join(dataRoot, 'MEMORY.md'), 'memory-v3', 'utf8');
      const changedSummary = await changed.complete({ sessionId: 'session-3' });
      expect(changedSummary.id).not.toBe(unchangedSummary.id);
      // The changed run committed; the unchanged one did not.
      expect(marks.slice(beforeThirdRun).some((line) => line.includes('"preimage-committed"'))).toBe(true);

      // The reuse must not become the only preimage: the changed run committed its own, which is what a
      // rollback of that run can rest on. (What a rollback then restores for a data file is the checkpoint's
      // own behaviour, covered by the next case; this one is about reuse versus commit.)
      expect(changedSummary.id).not.toBe(unchangedSummary.id);
      expect(await readFile(join(dataRoot, 'MEMORY.md'), 'utf8')).toBe('memory-v3');
    } finally {
      log.mockRestore();
      if (previousSwitch === undefined) delete process.env['LITTLESHEEP_BOOTSTRAP_TIMING'];
      else process.env['LITTLESHEEP_BOOTSTRAP_TIMING'] = previousSwitch;
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

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

  it('serializes concurrent run checkpoints that share one data repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-checkpoint-concurrent-'));
    try {
      const dataRoot = join(root, 'data');
      const workspaceA = join(root, 'workspace-a');
      const workspaceB = join(root, 'workspace-b');
      await mkdir(dataRoot, { recursive: true });
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });

      const firstCoordinator = new GitCheckpointCoordinator({ dataRoot });
      const secondCoordinator = new GitCheckpointCoordinator({ dataRoot });
      await firstCoordinator.initialize();
      await secondCoordinator.initialize();

      const [firstRun, secondRun] = await Promise.all([
        firstCoordinator.beginRun({ runId: 'run-concurrent-a', workspaceRoot: workspaceA }),
        secondCoordinator.beginRun({ runId: 'run-concurrent-b', workspaceRoot: workspaceB }),
      ]);
      await Promise.all([
        firstRun.beforeFileMutation(join(workspaceA, 'a.txt')),
        secondRun.beforeFileMutation(join(workspaceB, 'b.txt')),
      ]);
      await Promise.all([
        writeFile(join(workspaceA, 'a.txt'), 'a', 'utf8'),
        writeFile(join(workspaceB, 'b.txt'), 'b', 'utf8'),
      ]);
      const [firstSummary, secondSummary] = await Promise.all([
        firstRun.complete({ sessionId: 'session-concurrent-a' }),
        secondRun.complete({ sessionId: 'session-concurrent-b' }),
      ]);

      expect(firstSummary.status).toBe('complete');
      expect(secondSummary.status).toBe('complete');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
