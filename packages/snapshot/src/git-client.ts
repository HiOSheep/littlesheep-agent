import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_OUTPUT = 8_000_000;
const PATH_BATCH_SIZE = 128;

export interface ShadowGitRepositoryOptions {
  gitDir: string;
  workTree: string;
  excludePatterns?: readonly string[];
}

export class ShadowGitRepository {
  readonly gitDir: string;
  readonly workTree: string;
  private readonly excludePatterns: readonly string[];
  private initializePromise?: Promise<void>;

  constructor(options: ShadowGitRepositoryOptions) {
    this.gitDir = options.gitDir;
    this.workTree = options.workTree;
    this.excludePatterns = options.excludePatterns ?? [];
  }

  async initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeInternal();
    return this.initializePromise;
  }

  private async initializeInternal(): Promise<void> {
    if (!await exists(join(this.gitDir, 'HEAD'))) {
      await mkdir(dirname(this.gitDir), { recursive: true });
      await run('git', ['init', '--bare', this.gitDir]);
      await this.git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
      await this.git(['config', 'user.name', 'LittleSheep']);
      await this.git(['config', 'user.email', 'local@littlesheep.invalid']);
      await this.git(['config', 'commit.gpgSign', 'false']);
      await this.git(['config', 'core.autocrlf', 'false']);
    }
    if (this.excludePatterns.length > 0) {
      const excludePath = join(this.gitDir, 'info', 'exclude');
      await mkdir(dirname(excludePath), { recursive: true });
      await writeFile(excludePath, `${this.excludePatterns.join('\n')}\n`, 'utf8');
    }
  }

  async head(): Promise<string | undefined> {
    const result = await this.git(['rev-parse', '--verify', 'HEAD'], [0, 128]);
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }

  async commitAll(message: string, allowEmpty = false): Promise<string | undefined> {
    await this.initialize();
    await this.git(['add', '-A', '--', '.']);
    return this.commit(message, allowEmpty);
  }

  async commitPaths(paths: readonly string[], message: string, allowEmpty = false): Promise<string | undefined> {
    await this.initialize();
    const normalized = this.normalizePaths(paths);
    const existing: string[] = [];
    const missing: string[] = [];
    for (const path of normalized) {
      if (path === '.' || await exists(resolve(this.workTree, path))) existing.push(path);
      else missing.push(path);
    }
    if (missing.length > 0) {
      const tracked = new Set(await this.trackedPaths(missing));
      for (const path of missing) {
        if (tracked.has(path) || [...tracked].some((entry) => entry.startsWith(`${path}/`))) existing.push(path);
      }
    }
    for (const batch of batches(existing, PATH_BATCH_SIZE)) {
      await this.git(['add', '-A', '-f', '--', ...batch]);
    }
    return this.commit(message, allowEmpty);
  }

  async trackedPaths(paths: readonly string[] = ['.']): Promise<string[]> {
    await this.initialize();
    const normalized = this.normalizePaths(paths);
    const result = await this.git(['ls-files', '-z', '--', ...normalized]);
    return parseNullSeparated(result.stdout).map((path) => this.normalizePath(path));
  }

  async candidatePaths(): Promise<string[]> {
    await this.initialize();
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
    await this.git(['cat-file', '-e', `${commit}^{commit}`]);

    const [current, target] = await Promise.all([
      this.trackedPaths(normalized),
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
  }

  private async treePaths(commit: string, paths: readonly string[]): Promise<string[]> {
    const result = await this.git(['ls-tree', '-r', '--name-only', '-z', commit, '--', ...paths]);
    return parseNullSeparated(result.stdout).map((path) => this.normalizePath(path));
  }

  private async commit(message: string, allowEmpty: boolean): Promise<string | undefined> {
    const changed = (await this.git(['diff', '--cached', '--quiet'], [0, 1])).code === 1;
    if (!changed && !allowEmpty) return this.head();
    const args = ['commit', '--no-gpg-sign', '--no-verify'];
    if (allowEmpty) args.push('--allow-empty');
    args.push('-m', message.slice(0, 240));
    await this.git(args);
    return this.head();
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
