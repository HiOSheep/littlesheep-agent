// Shadow-repository Git plumbing: process spawn, locking, path normalization and the commit primitives.
//
// Owns one `git` invocation path for the versioning shadow repositories (data root and per-workspace), the
// per-repository mutation queue and lock file that serialize writers, and the queries the checkpoint
// coordinator asks of a repository: tracked paths, HEAD, work-tree changes, commit-or-reuse. It does not decide
// *what* to version — path selection and the preimage decision live in git-checkpoint-preimage.ts, the manifest
// store in checkpoint-manifest-store.ts and the transaction facade in git-checkpoint.ts.
import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireLock } from '@littlesheep/session';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MUTATION_LOCK_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT = 8_000_000;
const PATH_BATCH_SIZE = 128;

export interface ShadowGitRepositoryOptions {
  gitDir: string;
  workTree: string;
  excludePatterns?: readonly string[];
}

/** One path that differs from HEAD, with the porcelain code that says how. */
export interface WorkTreeChange {
  path: string;
  /** The two porcelain status letters, e.g. `??`, ` M`, ` D`, `M `. */
  code: string;
  /** The work tree no longer holds this path, so the commit has to record a removal. */
  deleted: boolean;
}

/** What `commitWorkTreeChanges` is allowed to stage. */
export interface ManagedCommitSelection {
  /** New paths to force-add, each one already selected and size-checked by the caller. */
  changed: readonly string[];
  /** Whether the index already holds tracked paths, so `git add -u` has something to update. */
  updateTracked: boolean;
}

export class ShadowGitRepository {
  private static readonly initializationPromises = new Map<string, Promise<void>>();
  private static readonly mutationQueues = new Map<string, Promise<unknown>>();

  readonly gitDir: string;
  readonly workTree: string;
  private readonly excludePatterns: readonly string[];
  private excludePromise?: Promise<void>;

  constructor(options: ShadowGitRepositoryOptions) {
    this.gitDir = options.gitDir;
    this.workTree = options.workTree;
    this.excludePatterns = options.excludePatterns ?? [];
  }

  async initialize(): Promise<void> {
    const key = repositoryKey(this.gitDir);
    let repositoryPromise = ShadowGitRepository.initializationPromises.get(key);
    if (!repositoryPromise) {
      repositoryPromise = this.initializeRepositoryInternal();
      ShadowGitRepository.initializationPromises.set(key, repositoryPromise);
      void repositoryPromise.catch(() => {
        if (ShadowGitRepository.initializationPromises.get(key) === repositoryPromise) {
          ShadowGitRepository.initializationPromises.delete(key);
        }
      });
    }
    await repositoryPromise;
    await this.ensureExcludePatterns();
  }

  private async initializeRepositoryInternal(): Promise<void> {
    await mkdir(this.gitDir, { recursive: true });
    await this.withRepositoryLock(async () => {
      if (!await exists(join(this.gitDir, 'HEAD'))) {
        await run('git', ['init', '--bare', this.gitDir]);
        await this.git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
        await this.git(['config', 'user.name', 'LittleSheep']);
        await this.git(['config', 'user.email', 'local@littlesheep.invalid']);
        await this.git(['config', 'commit.gpgSign', 'false']);
        await this.git(['config', 'core.autocrlf', 'false']);
      }
    });
  }

  private async ensureExcludePatterns(): Promise<void> {
    if (this.excludePatterns.length === 0) return;
    if (!this.excludePromise) {
      this.excludePromise = this.writeExcludePatterns();
    }
    await this.excludePromise;
  }

  private async writeExcludePatterns(): Promise<void> {
    const excludePath = join(this.gitDir, 'info', 'exclude');
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, `${this.excludePatterns.join('\n')}\n`, 'utf8');
  }

  private async headInternal(): Promise<string | undefined> {
    const result = await this.git(['rev-parse', '--verify', 'HEAD'], [0, 128]);
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }

  /** The commit HEAD points at, or undefined on an unborn branch. */
  async head(): Promise<string | undefined> {
    await this.initialize();
    return this.headInternal();
  }

  /**
   * True when the work tree matches HEAD exactly — asked of git rather than answered by a walk.
   *
   * The caller's alternative is walking every managed file and lstat-ing it: on a real data root (31k files
   * measured) that costs seconds, and it runs on the path to execution readiness. `git status` answers the
   * same question in one process, and it fails in the safe direction — any modification, addition or removal
   * of a tracked path makes it non-empty, so a caller that skips work on `true` only ever skips work that was
   * genuinely unnecessary.
   *
   * One caveat the callers honour: `--untracked-files=all` does not list *ignored* files, so a newly created
   * path matching an exclude pattern — the shadow repository's own or a `.gitignore` in the work tree — would
   * not appear here. A caller that also drives its path selection from this answer therefore never versions
   * such a path; the caller's explicit root-file list and the tracked set are what keep that from losing a
   * file the previous preimage already covered.
   */
  async isWorkTreeClean(): Promise<boolean> {
    return (await this.workTreeChanges()).length === 0;
  }

  /**
   * Every path that differs from HEAD, in one process and with no per-path `stat`.
   *
   * This is the path *source* the checkpoint coordinator now uses, not just a cleanliness probe: the
   * untracked entries are exactly the new files a commit has to force-add, and the modified/deleted entries
   * say which already-tracked files moved. `--no-renames` keeps one entry per path (a rename then reads as a
   * deletion plus an untracked addition) so no caller has to pair two records to find out what happened.
   *
   * Ignored paths are absent by design: the shadow repository's `info/exclude` is authoritative about what may
   * enter the repository, and a caller must never pass a *directory* of this result to `git add -f`.
   */
  async workTreeChanges(): Promise<WorkTreeChange[]> {
    await this.initialize();
    const result = await this.git([
      'status', '--porcelain', '-z', '--untracked-files=all', '--no-renames',
    ]);
    return parseWorkTreeChanges(result.stdout);
  }

  async commitAll(message: string, allowEmpty = false): Promise<string | undefined> {
    await this.initialize();
    return this.enqueueMutation(async () => {
      await this.git(['add', '-A', '--', '.']);
      return this.commitInternal(message, allowEmpty);
    });
  }

  async commitPaths(paths: readonly string[], message: string, allowEmpty = false): Promise<string | undefined> {
    await this.initialize();
    const normalized = this.normalizePaths(paths);
    return this.enqueueMutation(async () => {
      const existing: string[] = [];
      const missing: string[] = [];
      for (const path of normalized) {
        if (path === '.' || await exists(resolve(this.workTree, path))) existing.push(path);
        else missing.push(path);
      }
      if (missing.length > 0) {
        const tracked = new Set(await this.trackedPathsInternal(missing));
        for (const path of missing) {
          if (tracked.has(path) || [...tracked].some((entry) => entry.startsWith(`${path}/`))) existing.push(path);
        }
      }
      for (const batch of batches(existing, PATH_BATCH_SIZE)) {
        await this.git(['add', '-A', '-f', '--', ...batch]);
      }
      return this.commitInternal(message, allowEmpty);
    });
  }

  /**
   * Commit a git-derived selection: `git add -u` for whatever the index already tracks, explicit paths for the
   * few new files the caller force-adds.
   *
   * The difference from `commitPaths` is the cost model, and it is the whole point. `commitPaths` is told every
   * managed path and answers with one `exists()` per path plus one `git add` per 128 of them — on a 31k-path
   * data root that is 31k stats and ~240 processes, which is exactly the walk this selection replaces, moved
   * into git. Here `git add -u -- .` stages every modification and removal of tracked paths in ONE process
   * (git reads its own index; nothing stats a path from Node), and only the new/changed paths the caller
   * already stat-ed are named explicitly. `-f` is applied to those explicit paths alone — never to a
   * directory — so the repository's exclude patterns stay authoritative for everything else.
   */
  async commitWorkTreeChanges(
    selection: ManagedCommitSelection,
    message: string,
    allowEmpty = false,
  ): Promise<string | undefined> {
    await this.initialize();
    const changed = this.normalizePaths(selection.changed);
    return this.enqueueMutation(async () => {
      for (const batch of batches(changed, PATH_BATCH_SIZE)) {
        await this.git(['add', '-A', '-f', '--', ...batch]);
      }
      // `git add -u` errors on an unborn index ("pathspec '.' did not match any file(s) known to git"), so the
      // caller says whether the repository has tracked paths at all.
      if (selection.updateTracked) await this.git(['add', '-u', '--', '.']);
      return this.commitInternal(message, allowEmpty);
    });
  }

  async trackedPaths(paths: readonly string[] = ['.']): Promise<string[]> {
    await this.initialize();
    return this.trackedPathsInternal(paths);
  }

  private async trackedPathsInternal(paths: readonly string[] = ['.']): Promise<string[]> {
    const normalized = this.normalizePaths(paths);
    const result = await this.git(['ls-files', '-z', '--', ...normalized]);
    return parseNullSeparated(result.stdout).map((path) => this.normalizePath(path));
  }

  async candidatePaths(): Promise<string[]> {
    await this.initialize();
    return this.candidatePathsInternal();
  }

  private async candidatePathsInternal(): Promise<string[]> {
    const result = await this.git(['ls-files', '-co', '--exclude-standard', '-z']);
    return parseNullSeparated(result.stdout).map((path) => this.normalizePath(path));
  }

  /**
   * Restore only files already managed by this shadow repository. Untracked
   * user files are never cleaned or enumerated for deletion.
   */
  async restore(commit: string, paths: readonly string[]): Promise<void> {
    await this.initialize();
    const normalized = this.normalizePaths(paths);
    if (normalized.length === 0) throw new Error('git restore requires at least one managed path');
    return this.enqueueMutation(async () => {
      await this.git(['cat-file', '-e', `${commit}^{commit}`]);

      const [current, target] = await Promise.all([
        this.trackedPathsInternal(normalized),
        this.treePaths(commit, normalized),
      ]);
      const targetSet = new Set(target);
      for (const path of current) {
        if (targetSet.has(path)) continue;
        await rm(resolve(this.workTree, path), { force: true });
      }
      for (const batch of batches(target, PATH_BATCH_SIZE)) {
        await this.git(['checkout', commit, '--', ...batch]);
      }
      const affected = [...new Set([...current, ...target])];
      for (const batch of batches(affected, PATH_BATCH_SIZE)) {
        await this.git(['add', '-A', '-f', '--', ...batch]);
      }
    });
  }

  private async treePaths(commit: string, paths: readonly string[]): Promise<string[]> {
    const result = await this.git(['ls-tree', '-r', '--name-only', '-z', commit, '--', ...paths]);
    return parseNullSeparated(result.stdout).map((path) => this.normalizePath(path));
  }

  private async commitInternal(message: string, allowEmpty: boolean): Promise<string | undefined> {
    const changed = (await this.git(['diff', '--cached', '--quiet'], [0, 1])).code === 1;
    if (!changed && !allowEmpty) return this.headInternal();
    const args = ['commit', '--no-gpg-sign', '--no-verify'];
    if (allowEmpty) args.push('--allow-empty');
    args.push('-m', message.slice(0, 240));
    await this.git(args);
    return this.headInternal();
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const key = repositoryKey(this.gitDir);
    const previous = ShadowGitRepository.mutationQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.withRepositoryLock(operation));
    ShadowGitRepository.mutationQueues.set(key, next);
    const cleanup = () => {
      if (ShadowGitRepository.mutationQueues.get(key) === next) {
        ShadowGitRepository.mutationQueues.delete(key);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  private async withRepositoryLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await acquireLock(
      join(this.gitDir, 'littlesheep-mutation'),
      GIT_MUTATION_LOCK_TIMEOUT_MS,
    );
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  private git(args: readonly string[], acceptedCodes: readonly number[] = [0]): Promise<ProcessResult> {
    return run('git', [`--git-dir=${this.gitDir}`, `--work-tree=${this.workTree}`, ...args], acceptedCodes);
  }

  private normalizePaths(paths: readonly string[]): string[] {
    return [...new Set(paths.map((path) => this.normalizePath(path)))];
  }

  private normalizePath(path: string): string {
    const raw = path.trim();
    if (!raw) throw new Error('git path must not be empty');
    if (raw === '.') return raw;
    const absolute = isAbsolute(raw) ? resolve(raw) : resolve(this.workTree, raw);
    const rel = relative(this.workTree, absolute);
    if (!rel || rel === '.') return '.';
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`git path escapes work tree: ${path}`);
    }
    return rel.split(sep).join('/');
  }
}

function repositoryKey(gitDir: string): string {
  const resolved = resolve(gitDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: readonly string[], acceptedCodes: readonly number[] = [0]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_GIT_OUTPUT) stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_GIT_OUTPUT) stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (codeValue) => {
      clearTimeout(timer);
      const code = codeValue ?? -1;
      if (!acceptedCodes.includes(code)) {
        reject(new Error(`git exited ${code}: ${stderr.trim().slice(0, 500)}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parseNullSeparated(value: string): string[] {
  return value.split('\0').filter(Boolean);
}

/**
 * Read `status --porcelain -z`. With `-z` each record is `XY<space>path<NUL>`; rename/copy records (which
 * `--no-renames` suppresses, kept here as a guard) append the original path as a further record.
 */
function parseWorkTreeChanges(stdout: string): WorkTreeChange[] {
  const records = stdout.split('\0');
  const changes: WorkTreeChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;
    changes.push({ path, code, deleted: code.includes('D') });
    if (code.includes('R') || code.includes('C')) index += 1;
  }
  return changes;
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size) as T[]);
  }
  return result;
}
