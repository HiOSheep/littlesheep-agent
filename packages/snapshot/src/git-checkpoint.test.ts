import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { GitCheckpointCoordinator } from './git-checkpoint.js';
import { DATA_ROOT_FILES, isManagedDataPath } from './git-checkpoint-files.js';

const run = promisify(execFile);

/**
 * Every `lstat` and every `readFile` the checkpoint code performs, so a test can assert what a start actually
 * reads. The walk this replaced lstat-ed every managed file on every start and recovery read every manifest;
 * the assertions below are the difference between that and a stat of the paths git reported as changed.
 */
const probe = vi.hoisted(() => ({ lstat: [] as string[], reads: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      probe.lstat.push(String(args[0]));
      return actual.lstat(...args);
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      probe.reads.push(String(args[0]));
      return actual.readFile(...args);
    },
  };
});

function dataGitDir(dataRoot: string): string {
  return join(dataRoot, 'backups', 'versioning', 'repositories', 'data.git');
}

function manifestReads(dataRoot: string): string[] {
  const manifestsDir = join(dataRoot, 'backups', 'versioning', 'checkpoints');
  return probe.reads.filter((path) => path.startsWith(manifestsDir));
}

async function showAtCommit(dataRoot: string, commit: string, path: string): Promise<string> {
  const result = await run('git', [`--git-dir=${dataGitDir(dataRoot)}`, 'show', `${commit}:${path}`], {
    windowsHide: true,
  });
  return result.stdout;
}

async function trackedInDataRepository(dataRoot: string): Promise<string[]> {
  const result = await run('git', [`--git-dir=${dataGitDir(dataRoot)}`, 'ls-files', '-z'], {
    windowsHide: true,
    maxBuffer: 8_000_000,
  });
  return result.stdout.split('\0').filter(Boolean);
}

/** How many managed data paths this start `lstat`-ed — the number the deleted walk made proportional to size. */
function managedStatCount(dataRoot: string, paths: readonly string[]): number {
  return paths.filter((path) => {
    const rel = relative(dataRoot, path);
    return !!rel && !rel.startsWith('..') && isManagedDataPath(rel);
  }).length;
}

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

  // The path list is now git's answer (ls-files + status) instead of a walk, so the cases below pin what that
  // answer must still cover. Each one fails if the selection loses a kind of change.
  it('commits a modified managed file, so the run keeps a real rollback point', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-checkpoint-modified-'));
    try {
      const dataRoot = join(root, 'data');
      const workspace = join(root, 'workspace');
      await mkdir(join(dataRoot, 'memory'), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(dataRoot, 'memory', 'notes.md'), 'v1', 'utf8');

      const coordinator = new GitCheckpointCoordinator({ dataRoot });
      await coordinator.initialize();
      const first = await coordinator.beginRun({ runId: 'run-1', workspaceRoot: workspace });
      const firstSummary = await first.complete();

      await writeFile(join(dataRoot, 'memory', 'notes.md'), 'v2', 'utf8');
      const second = await coordinator.beginRun({ runId: 'run-2', workspaceRoot: workspace });
      const secondSummary = await second.complete();

      // Each completion's commit holds the content as it was then; the modification is not silently skipped.
      expect(await showAtCommit(dataRoot, firstSummary.dataCommit!, 'memory/notes.md')).toBe('v1');
      expect(await showAtCommit(dataRoot, secondSummary.dataCommit!, 'memory/notes.md')).toBe('v2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('commits an added managed file and records the removal of a deleted one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-checkpoint-added-removed-'));
    try {
      const dataRoot = join(root, 'data');
      const workspace = join(root, 'workspace');
      await mkdir(join(dataRoot, 'memory'), { recursive: true });
      await mkdir(join(dataRoot, 'projects'), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(dataRoot, 'memory', 'keep.md'), 'keep-v1', 'utf8');
      await writeFile(join(dataRoot, 'projects', 'gone.md'), 'gone-v1', 'utf8');

      const coordinator = new GitCheckpointCoordinator({ dataRoot });
      await coordinator.initialize();
      const first = await coordinator.beginRun({ runId: 'run-1', workspaceRoot: workspace });
      const firstSummary = await first.complete();
      expect(await showAtCommit(dataRoot, firstSummary.dataCommit!, 'projects/gone.md')).toBe('gone-v1');

      await writeFile(join(dataRoot, 'memory', 'added.md'), 'added-v1', 'utf8');
      await rm(join(dataRoot, 'projects', 'gone.md'), { force: true });
      const second = await coordinator.beginRun({ runId: 'run-2', workspaceRoot: workspace });
      const secondSummary = await second.complete();

      expect(await showAtCommit(dataRoot, secondSummary.dataCommit!, 'memory/added.md')).toBe('added-v1');
      // The removal is in the commit: `git add -u` stages a deletion of a path that is no longer on disk, which
      // is why the selection does not have to stat the tracked set to notice it.
      await expect(showAtCommit(dataRoot, secondSummary.dataCommit!, 'projects/gone.md')).rejects.toThrow();
      expect(await showAtCommit(dataRoot, firstSummary.dataCommit!, 'projects/gone.md')).toBe('gone-v1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('never versions an excluded directory or an excluded file inside a managed one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-checkpoint-excluded-'));
    try {
      const dataRoot = join(root, 'data');
      const workspace = join(root, 'workspace');
      await mkdir(join(dataRoot, 'memory'), { recursive: true });
      await mkdir(join(dataRoot, 'attachment-cache', 'files'), { recursive: true });
      await mkdir(join(dataRoot, 'models'), { recursive: true });
      await mkdir(join(dataRoot, 'quarantine'), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(dataRoot, 'memory', 'keep.md'), 'managed', 'utf8');
      // Inside a managed root, but excluded by the extension rules — the case `git add -f` would otherwise let
      // in, since `-f` overrides the repository's exclude patterns.
      await writeFile(join(dataRoot, 'memory', 'catalog.sqlite'), 'sqlite', 'utf8');
      await writeFile(join(dataRoot, 'memory', 'catalog.sqlite-wal'), 'wal', 'utf8');
      await writeFile(join(dataRoot, 'memory', 'trace.log'), 'log', 'utf8');
      await writeFile(join(dataRoot, 'memory', 'scratch.tmp'), 'tmp', 'utf8');
      // Excluded directories, both at the root and nested inside a managed one.
      await writeFile(join(dataRoot, 'attachment-cache', 'files', 'blob.bin'), 'attachment', 'utf8');
      await writeFile(join(dataRoot, 'models', 'embedding.bin'), 'model', 'utf8');
      await writeFile(join(dataRoot, 'quarantine', 'suspicious.txt'), 'quarantine', 'utf8');
      await mkdir(join(dataRoot, 'memory', 'backups'), { recursive: true });
      await writeFile(join(dataRoot, 'memory', 'backups', 'old.md'), 'nested backup', 'utf8');

      const coordinator = new GitCheckpointCoordinator({ dataRoot });
      await coordinator.initialize();
      const checkpoint = await coordinator.beginRun({ runId: 'run-1', workspaceRoot: workspace });
      await checkpoint.complete();

      const tracked = await trackedInDataRepository(dataRoot);
      expect(tracked).toContain('memory/keep.md');
      for (const excluded of [
        'memory/catalog.sqlite',
        'memory/catalog.sqlite-wal',
        'memory/trace.log',
        'memory/scratch.tmp',
        'attachment-cache/files/blob.bin',
        'models/embedding.bin',
        'quarantine/suspicious.txt',
        'memory/backups/old.md',
      ]) {
        expect(tracked).not.toContain(excluded);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('recovers a checkpoint left pending by an interrupted start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-checkpoint-pending-'));
    try {
      const dataRoot = join(root, 'data');
      const workspace = join(root, 'workspace');
      await mkdir(join(dataRoot, 'memory'), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(dataRoot, 'MEMORY.md'), 'memory-v1', 'utf8');

      const interrupted = new GitCheckpointCoordinator({ dataRoot });
      await interrupted.initialize();
      const run = await interrupted.beginRun({ runId: 'run-interrupted', workspaceRoot: workspace });

      // No complete(): the process is gone. A restart must find the pending checkpoint from its cheap record.
      probe.reads.length = 0;
      const restarted = new GitCheckpointCoordinator({ dataRoot });
      await restarted.initialize();
      // One manifest read — the interrupted one — instead of one per checkpoint in the directory.
      expect(manifestReads(dataRoot)).toHaveLength(1);
      const recovered = await restarted.summary(run.id);

      expect(recovered.status).toBe('partial');
      expect(recovered.warningCodes).toContain('recovered-incomplete-checkpoint');
      // The record is spent, so the next start has nothing pending to read.
      expect(await readdir(join(dataRoot, 'backups', 'versioning', 'pending-runs'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  // The cheap recovery only stays cheap if a settled run leaves no record behind: otherwise every start would
  // read one manifest per finished run, which is the cost this replaced.
  it('leaves no pending record behind once a run settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-checkpoint-settled-'));
    try {
      const dataRoot = join(root, 'data');
      const workspace = join(root, 'workspace');
      await mkdir(join(dataRoot, 'memory'), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(dataRoot, 'MEMORY.md'), 'memory-v1', 'utf8');

      const coordinator = new GitCheckpointCoordinator({ dataRoot });
      await coordinator.initialize();
      for (const runId of ['run-1', 'run-2', 'run-3']) {
        const run = await coordinator.beginRun({ runId, workspaceRoot: workspace });
        await writeFile(join(dataRoot, 'MEMORY.md'), `memory-${runId}`, 'utf8');
        await run.complete();
      }

      const pendingRuns = join(dataRoot, 'backups', 'versioning', 'pending-runs');
      expect(await readdir(pendingRuns)).toEqual([]);

      // A restart with three settled runs reads no manifest at all: the read count is the observable.
      probe.reads.length = 0;
      const restarted = new GitCheckpointCoordinator({ dataRoot });
      await restarted.initialize();
      expect(manifestReads(dataRoot)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('still recovers a pending manifest written before the pending record existed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-checkpoint-pending-legacy-'));
    try {
      const dataRoot = join(root, 'data');
      const workspace = join(root, 'workspace');
      await mkdir(join(dataRoot, 'memory'), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(dataRoot, 'MEMORY.md'), 'memory-v1', 'utf8');

      const coordinator = new GitCheckpointCoordinator({ dataRoot });
      await coordinator.initialize();
      const run = await coordinator.beginRun({ runId: 'run-legacy', workspaceRoot: workspace });
      // A data root written by the previous version: the pending manifest exists, the record directory does not.
      await rm(join(dataRoot, 'backups', 'versioning', 'pending-runs'), { recursive: true, force: true });

      const restarted = new GitCheckpointCoordinator({ dataRoot });
      await restarted.initialize();
      const recovered = await restarted.summary(run.id);

      expect(recovered.status).toBe('partial');
      expect(recovered.warningCodes).toContain('recovered-incomplete-checkpoint');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('selects paths from git instead of stat-ing every managed file on a start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-checkpoint-nostat-'));
    try {
      const dataRoot = join(root, 'data');
      const workspace = join(root, 'workspace');
      await mkdir(join(dataRoot, 'memory'), { recursive: true });
      await mkdir(workspace, { recursive: true });
      const fileCount = 200;
      for (let index = 0; index < fileCount; index += 1) {
        await writeFile(join(dataRoot, 'memory', `note-${index}.md`), `v1-${index}`, 'utf8');
      }

      const coordinator = new GitCheckpointCoordinator({ dataRoot });
      await coordinator.initialize();
      const first = await coordinator.beginRun({ runId: 'run-1', workspaceRoot: workspace });
      await first.complete();

      // A clean start: nothing to commit, and nothing to read.
      probe.lstat.length = 0;
      await new GitCheckpointCoordinator({ dataRoot }).initialize();
      expect(managedStatCount(dataRoot, probe.lstat)).toBe(0);

      // A dirty start is the normal case (the app writes into managed directories between launches): the named
      // root files plus the one new path are the only managed paths stat-ed, so the other `fileCount` are never
      // touched. The old walk stat-ed all of them here, on every start.
      await writeFile(join(dataRoot, 'memory', 'note-7.md'), 'v2-7', 'utf8');
      await writeFile(join(dataRoot, 'memory', 'note-new.md'), 'created', 'utf8');
      probe.lstat.length = 0;
      const dirty = new GitCheckpointCoordinator({ dataRoot });
      const summary = await dirty.initialize();
      const statted = managedStatCount(dataRoot, probe.lstat);
      expect(statted).toBeGreaterThan(0);
      expect(statted).toBeLessThanOrEqual(DATA_ROOT_FILES.size + 2);
      // ... and both changes are in the commit the start created, not merely skipped.
      expect(await showAtCommit(dataRoot, summary.dataCommit!, 'memory/note-7.md')).toBe('v2-7');
      expect(await showAtCommit(dataRoot, summary.dataCommit!, 'memory/note-new.md')).toBe('created');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
