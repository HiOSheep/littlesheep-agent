// @littlesheep/memory-tree — git-log.ts
// Git log collection for ProjectMemoryBranch.
//
// Uses `promisify(execFile)` (same pattern as `import-repo.ts:25`) to spawn
// `git log` subprocesses. Zero SDK dependency — no `simple-git`, just the git
// binary on PATH. This matches the project ethos of minimal native deps.
//
// Error handling contract:
//   - Empty repo (no commits yet) → returns [] / null (graceful)
//   - Non-git directory → throws (caller should not cache, next access retries)
//   - Other git failures → throws
//
// The "empty repo returns []" distinction is made by inspecting stderr for the
// stable "does not have any commits yet" message. Non-git errors ("not a git
// repository") and all other errors propagate to the caller. The caller
// (ProjectMemoryBranch.collectRecentChanges) catches all errors and returns []
// without caching, so a non-git project triggers one failed git call per turn
// (known limitation — future optimization: cache "is not a git repo" flag).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitLogEntry } from './types.js';

const execFileP = promisify(execFile);

/** Max buffer for git log output (4MB — enough for ~10k commits at ~400 bytes each). */
const MAX_GIT_BUFFER = 4 * 1024 * 1024;

/**
 * Check if a git error indicates "no commits yet" (empty repo).
 *
 * Git's stable error message for this case is:
 *   "fatal: your current branch 'main' does not have any commits yet"
 *
 * We check stderr because git exits with code 128 for both "no commits" and
 * "not a git repository" — the distinction is only in stderr text.
 */
function isNoCommitsError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const stderr = (err as { stderr?: string }).stderr ?? '';
  return stderr.includes('does not have any commits yet');
}

/**
 * Fetch recent git log entries for a project.
 *
 * Command: `git log -N --format=%h%x09%cI%x09%s --no-merges`
 *   - %h: abbreviated commit hash (e.g. "a3ccbac")
 *   - %x09: tab separator (parses cleanly, never appears in hash/date)
 *   - %cI: committer date, strict ISO 8601 (e.g. "2026-07-07T10:00:00+08:00")
 *   - %s: subject (first line of commit message)
 *   - --no-merges: exclude merge commits (noise for context injection)
 *
 * Returns [] for an empty repo (no commits). Throws for non-git directories
 * or other git failures. Callers should catch and return [] without caching
 * on error (see ProjectMemoryBranch.collectRecentChanges).
 *
 * @param cwd Project root directory
 * @param maxCommits Max number of commits to return (default 10, clamped to ≥1)
 * @param signal Optional AbortSignal for cancellation
 */
export async function fetchGitLog(
  cwd: string,
  maxCommits: number = 10,
  signal?: AbortSignal,
): Promise<GitLogEntry[]> {
  const n = Math.max(1, Math.floor(maxCommits));
  try {
    const { stdout } = await execFileP(
      'git',
      ['log', `-${n}`, '--format=%h%x09%cI%x09%s', '--no-merges'],
      { cwd, signal, maxBuffer: MAX_GIT_BUFFER },
    );
    return parseGitLog(stdout);
  } catch (err) {
    if (isNoCommitsError(err)) return [];
    throw err;
  }
}

/**
 * Fetch the latest commit date (ISO 8601) for a project.
 *
 * Command: `git log -1 --format=%cI`
 *
 * Returns null for an empty repo (no commits). Throws for non-git directories.
 * Used by ProjectMemoryBranch to update `lastActiveAt` in the project index
 * (passive check — no event listener needed, see design doc §7.3).
 *
 * @param cwd Project root directory
 * @param signal Optional AbortSignal for cancellation
 */
export async function fetchLatestCommitDate(
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['log', '-1', '--format=%cI'],
      { cwd, signal, maxBuffer: MAX_GIT_BUFFER },
    );
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch (err) {
    if (isNoCommitsError(err)) return null;
    throw err;
  }
}

/**
 * Parse `git log --format=%h%x09%cI%x09%s` output into GitLogEntry[].
 *
 * Each line is `hash<TAB>date<TAB>subject`. Empty lines are skipped.
 * Lines without at least 2 tabs (malformed) are skipped defensively.
 * The subject may contain tabs (rare); we join the remaining parts to
 * preserve the full message.
 *
 * Visible for testing. Not part of the public API.
 */
export function parseGitLog(stdout: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const hash = parts[0];
    const date = parts[1];
    if (!hash || !date) continue;
    const message = parts.slice(2).join('\t');
    entries.push({ hash, date, message });
  }
  return entries;
}
