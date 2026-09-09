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

  async head(): Promise<string | undefined> {
    return this.headInternal();
  }

  private async headInternal(): Promise<string | undefined> {
    const result = await this.git(['rev-parse', '--verify', 'HEAD'], [0, 128]);
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
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

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size) as T[]);
  }
  return result;
}
