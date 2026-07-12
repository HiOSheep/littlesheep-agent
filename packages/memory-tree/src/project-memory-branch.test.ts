import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionId } from '@littlesheep/types';
import { ProjectMemoryBranch } from './project-memory-branch.js';
import type { GitLogEntry, MemoryBranchContext, ProjectEntry } from './types.js';

const NOW = new Date('2026-07-10T00:00:00.000Z');
const COMMITS: GitLogEntry[] = [
  { hash: 'abc1234', date: '2026-07-09T12:00:00.000Z', message: 'add memory index' },
  { hash: 'def5678', date: '2026-07-08T12:00:00.000Z', message: 'fix workspace shell' },
];
const CURRENT: ProjectEntry = { id: 'current', path: 'D:/work/current', lastActiveAt: '2026-07-09T00:00:00.000Z' };
const OTHER: ProjectEntry = { id: 'other', path: 'D:/work/other', lastActiveAt: '2026-07-01T00:00:00.000Z' };
let tempDir: string;

function context(): MemoryBranchContext {
  return {
    runId: 'run-1', sessionId: 'session-1' as SessionId, query: '', recentHistory: [],
    workspace: CURRENT.path, signal: new AbortController().signal, now: NOW,
  };
}

function makeBranch(options: { projects?: ProjectEntry[]; ttl?: number; fetch?: (cwd: string, max: number, signal?: AbortSignal) => Promise<GitLogEntry[]> } = {}) {
  mkdirSync(join(tempDir, 'projects'), { recursive: true });
  writeFileSync(join(tempDir, 'projects', 'index.json'), JSON.stringify({ projects: options.projects ?? [OTHER, CURRENT] }));
  const fetch = options.fetch ?? vi.fn(async () => COMMITS);
  return {
    branch: new ProjectMemoryBranch({ dataDir: tempDir, fetchGitLog: fetch, cacheTtlMs: options.ttl }),
    fetch,
  };
}

beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'ls-project-memory-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); vi.useRealTimers(); });

describe('ProjectMemoryBranch index-first retrieval', () => {
  it('builds the project index without fetching git and prioritizes the current workspace', async () => {
    const { branch, fetch } = makeBranch();
    const index = await branch.getIndex(context());
    expect(fetch).not.toHaveBeenCalled();
    expect(index.entries.map((entry) => entry.title)).toEqual(['current', 'other']);
    expect(index.entries[0]?.summary).toContain('current workspace');
  });

  it('fetches only after explicit expansion and reuses the TTL cache', async () => {
    const { branch, fetch } = makeBranch();
    const request = { nodeId: 'legacy-project:current', limit: 10, tokenBudget: 1_000 };
    const first = await branch.expand(context(), request);
    const second = await branch.expand(context(), request);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.fragments).toHaveLength(2);
    expect(second.fragments[0]?.dedupKey).toBe(first.fragments[0]?.dedupKey);
  });

  it('re-fetches after invalidation', async () => {
    const { branch, fetch } = makeBranch();
    const request = { nodeId: 'legacy-project:current', limit: 10, tokenBudget: 1_000 };
    await branch.expand(context(), request);
    await branch.invalidate();
    await branch.expand(context(), request);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('git unavailable')).mockResolvedValueOnce(COMMITS);
    const { branch } = makeBranch({ fetch });
    const request = { nodeId: 'legacy-project:current', limit: 10, tokenBudget: 1_000 };
    expect((await branch.expand(context(), request)).fragments).toHaveLength(0);
    expect((await branch.expand(context(), request)).fragments).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent fetches for the same project', async () => {
    let resolveFetch!: (value: GitLogEntry[]) => void;
    const fetch = vi.fn(() => new Promise<GitLogEntry[]>((resolve) => { resolveFetch = resolve; }));
    const { branch } = makeBranch({ fetch });
    const request = { nodeId: 'legacy-project:current', limit: 10, tokenBudget: 1_000 };
    const first = branch.expand(context(), request);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const second = branch.expand(context(), request);
    resolveFetch(COMMITS);
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('deep-searches commit messages on demand', async () => {
    const { branch } = makeBranch();
    const result = await branch.search(context(), { query: 'memory index', limit: 10, tokenBudget: 1_000 });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((entry) => entry.content.includes('add memory index'))).toBe(true);
  });
});
