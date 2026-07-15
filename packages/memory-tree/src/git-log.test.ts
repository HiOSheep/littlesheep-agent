// @littlesheep/memory-tree — git-log.test.ts
// Tests fetchGitLog / fetchLatestCommitDate against real git repos.
//
// Uses mkdtempSync + `git init` + real commits (no mocking of execFile —
// mocking across the module boundary is fragile, see import-repo.test.ts
// documented convention). Each test gets a fresh temp repo.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchGitLog, fetchLatestCommitDate, parseGitLog } from './git-log.js';

const execFileP = promisify(execFile);

let repoDir: string | undefined;

const GIT_TEST_TIMEOUT_MS = 60_000;
const GIT_TEST_CONFIG = [
  '-c', 'gc.auto=0',
  '-c', 'core.autocrlf=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'user.email=test@example.com',
  '-c', 'user.name=Test User',
];

/** Run a git command in repoDir. */
async function git(args: string[]): Promise<void> {
  if (!repoDir) throw new Error('Git test repository is not initialized.');
  await execFileP('git', [...GIT_TEST_CONFIG, ...args], {
    cwd: repoDir,
    timeout: GIT_TEST_TIMEOUT_MS - 5_000,
    windowsHide: true,
  });
}

/** Create a commit with a unique file so each commit has a distinct tree. */
async function commit(message: string): Promise<void> {
  if (!repoDir) throw new Error('Git test repository is not initialized.');
  const fname = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  writeFileSync(join(repoDir, fname), 'x');
  await git(['add', '-A']);
  await git(['commit', '-m', message]);
}

describe('parseGitLog', () => {
  it('parses 3 lines into 3 GitLogEntry with correct fields', () => {
    const stdout = 'a3ccbac\t2026-07-07T10:00:00+08:00\tPhase 6 done\n6a3ccb\t2026-07-06T15:30:00+08:00\tQQ Bot plugin\nf1a2b3\t2026-07-05T09:00:00+08:00\tFeishu channel\n';
    const entries = parseGitLog(stdout);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      hash: 'a3ccbac',
      date: '2026-07-07T10:00:00+08:00',
      message: 'Phase 6 done',
    });
    expect(entries[2]?.message).toBe('Feishu channel');
  });

  it('skips empty lines and malformed entries', () => {
    const stdout = 'a3ccbac\t2026-07-07T10:00:00+08:00\tvalid\n\nmalformed-no-tabs\n';
    const entries = parseGitLog(stdout);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe('valid');
  });

  it('preserves tabs in commit subject by joining remaining parts', () => {
    const stdout = 'a3ccbac\t2026-07-07T10:00:00+08:00\ttab\tin\tsubject\n';
    const entries = parseGitLog(stdout);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe('tab\tin\tsubject');
  });
});

describe('fetchGitLog — real git repo', () => {
  useRealGitRepo();

  it('parses 3 commits into 3 GitLogEntry with correct fields', async () => {
    await commit('first commit');
    await commit('second commit');
    await commit('third commit');
    const entries = await fetchGitLog(repoDir!, 10);
    expect(entries).toHaveLength(3);
    // Newest first (git log default order)
    expect(entries[0]?.message).toBe('third commit');
    expect(entries[0]?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(entries[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entries[2]?.message).toBe('first commit');
  });

  it('excludes merge commits via --no-merges', async () => {
    await commit('base');
    await git(['checkout', '-b', 'feature']);
    await commit('feature work');
    // Go back to the default branch (previous branch).
    await git(['checkout', '-']);
    await git(['merge', '--no-ff', 'feature', '-m', 'merge feature']);

    const entries = await fetchGitLog(repoDir!, 10);
    const messages = entries.map((e) => e.message);
    // Merge commit is excluded by --no-merges.
    expect(messages).not.toContain('merge feature');
    // Regular commits are still shown.
    expect(messages).toContain('feature work');
    expect(messages).toContain('base');
  });

  it('respects maxCommits limit', async () => {
    for (let i = 0; i < 5; i++) {
      await commit(`commit-${i}`);
    }
    const entries = await fetchGitLog(repoDir!, 3);
    expect(entries).toHaveLength(3);
    // Newest first
    expect(entries[0]?.message).toBe('commit-4');
    expect(entries[2]?.message).toBe('commit-2');
  });

  it('returns [] for empty repo (no commits)', async () => {
    const entries = await fetchGitLog(repoDir!, 10);
    expect(entries).toEqual([]);
  });

  it('throws for non-git directory', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'mtree-nongit-'));
    try {
      await expect(fetchGitLog(nonGit, 10)).rejects.toThrow();
    } finally {
      await removeTempDir(nonGit);
    }
  });
});

describe('fetchLatestCommitDate — real git repo', () => {
  useRealGitRepo();

  it('returns ISO date for repo with commits', async () => {
    await commit('test commit');
    const date = await fetchLatestCommitDate(repoDir!);
    expect(date).not.toBeNull();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('returns null for empty repo (no commits)', async () => {
    const date = await fetchLatestCommitDate(repoDir!);
    expect(date).toBeNull();
  });

  it('throws for non-git directory', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'mtree-nongit-'));
    try {
      await expect(fetchLatestCommitDate(nonGit)).rejects.toThrow();
    } finally {
      await removeTempDir(nonGit);
    }
  });
});

function useRealGitRepo(): void {
  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'mtree-git-'));
    await git(['init', '--quiet']);
  }, GIT_TEST_TIMEOUT_MS);

  afterEach(async () => {
    const current = repoDir;
    repoDir = undefined;
    if (current) await removeTempDir(current);
  }, GIT_TEST_TIMEOUT_MS);
}

async function removeTempDir(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 1,
    retryDelay: 100,
  });
}
