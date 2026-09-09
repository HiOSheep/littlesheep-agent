import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '@littlesheep/session';
import { ShadowGitRepository } from './git-client.js';

describe('ShadowGitRepository', () => {
  it('restores managed files without deleting unrelated untracked files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-shadow-git-'));
    try {
      const workTree = join(root, 'worktree');
      await mkdir(workTree, { recursive: true });
      await writeFile(join(workTree, 'managed.txt'), 'v1', 'utf8');
      const repository = new ShadowGitRepository({
        gitDir: join(root, 'repository.git'),
        workTree,
      });
      const first = await repository.commitPaths(['managed.txt'], 'first', true);
      await writeFile(join(workTree, 'managed.txt'), 'v2', 'utf8');
      await writeFile(join(workTree, 'created-after-first.txt'), 'tracked in second checkpoint', 'utf8');
      await writeFile(join(workTree, 'unrelated.txt'), 'keep outside rollback', 'utf8');
      await repository.commitPaths(['managed.txt', 'created-after-first.txt'], 'second', true);

      await repository.restore(first!, ['.']);

      expect(await readFile(join(workTree, 'managed.txt'), 'utf8')).toBe('v1');
      await expect(readFile(join(workTree, 'created-after-first.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(workTree, 'unrelated.txt'), 'utf8')).toBe('keep outside rollback');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits for the shared repository mutation lock before committing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-shadow-git-lock-'));
    try {
      const workTree = join(root, 'worktree');
      await mkdir(workTree, { recursive: true });
      await writeFile(join(workTree, 'managed.txt'), 'v1', 'utf8');
      const repository = new ShadowGitRepository({
        gitDir: join(root, 'repository.git'),
        workTree,
      });
      await repository.initialize();

      const lock = await acquireLock(join(repository.gitDir, 'littlesheep-mutation'), 5_000);
      let committed = false;
      const commit = repository.commitPaths(['managed.txt'], 'locked commit', true).then(() => {
        committed = true;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(committed).toBe(false);
      } finally {
        await lock.release();
      }
      await commit;
      expect(committed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
