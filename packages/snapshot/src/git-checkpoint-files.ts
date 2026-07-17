// Checkpoint filesystem policy and manifest codec.
// Keeps data/workspace traversal, exclusions, path identities and atomic JSON
// persistence out of the coordinator's transaction flow.

import { createHash, randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { VersionCheckpointManifest, VersionCheckpointSummary } from '@littlesheep/types';

export const DEFAULT_MAX_CHECKPOINTS = 256;
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_WORKSPACE_FILES = 20_000;
export const DEFAULT_MAX_WORKSPACE_BYTES = 512 * 1024 * 1024;

const DATA_ROOT_FILES = new Set([
  'AGENTS.md',
  'MEMORY.md',
  'PHILOSOPHY.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
  'config.json',
  'sessions.json',
]);
const DATA_ROOT_DIRS = new Set([
  'archive',
  'experience',
  'memory',
  'memory-tree',
  'projects',
  'sessions',
  'skills',
  'workspace',
]);
const WORKSPACE_EXCLUDED_SEGMENTS = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.turbo', '.vite',
  'node_modules', 'coverage', 'dist', 'out', 'build', 'release', 'target',
]);

export async function collectDataFiles(dataRoot: string, maxFileBytes: number): Promise<string[]> {
  const result: string[] = [];
  for (const file of DATA_ROOT_FILES) {
    const absolute = join(dataRoot, file);
    const info = await safeLstat(absolute);
    if (info?.isFile() && !info.isSymbolicLink() && info.size <= maxFileBytes) result.push(file);
  }
  for (const directory of DATA_ROOT_DIRS) {
    const root = join(dataRoot, directory);
    await walkFiles(root, async (absolute, info) => {
      const path = toGitPath(relative(dataRoot, absolute));
      if (info.size <= maxFileBytes && isManagedDataPath(path)) result.push(path);
    }, (absolute) => dataDirectoryExcluded(toGitPath(relative(dataRoot, absolute))));
  }
  return result;
}

export function isManagedDataPath(path: string): boolean {
  const normalized = toGitPath(path);
  const [root] = normalized.split('/');
  if (!root) return false;
  if (!normalized.includes('/')) return DATA_ROOT_FILES.has(root);
  if (!DATA_ROOT_DIRS.has(root)) return false;
  return !dataFileExcluded(normalized);
}

export function workspacePathExcluded(path: string): boolean {
  return toGitPath(path).split('/').some((segment) => WORKSPACE_EXCLUDED_SEGMENTS.has(segment.toLocaleLowerCase()));
}

export function isSensitiveWorkspaceFile(path: string): boolean {
  const name = basename(path).toLocaleLowerCase();
  return name === '.env'
    || name.startsWith('.env.')
    || name.includes('credential')
    || name.includes('secret')
    || name === 'id_rsa'
    || name.endsWith('.pem')
    || name.endsWith('.key')
    || name.endsWith('.p12')
    || name.endsWith('.pfx');
}

export async function walkWorkspaceFiles(
  workspaceRoot: string,
  maxFileBytes: number,
  maxWorkspaceFiles: number,
  maxWorkspaceBytes: number,
): Promise<string[]> {
  const root = resolve(workspaceRoot);
  const result: string[] = [];
  let totalBytes = 0;
  await walkFiles(root, async (absolute, info) => {
    const path = toGitPath(relative(root, absolute));
    if (!path || workspacePathExcluded(path) || isSensitiveWorkspaceFile(path)) return;
    if (info.size > maxFileBytes) return;
    result.push(path);
    totalBytes += info.size;
    if (result.length > maxWorkspaceFiles) {
      throw new Error(`versioning workspace exceeds ${maxWorkspaceFiles} files`);
    }
    if (totalBytes > maxWorkspaceBytes) {
      throw new Error(`versioning workspace exceeds ${maxWorkspaceBytes} bytes`);
    }
  }, (absolute) => {
    const path = toGitPath(relative(root, absolute));
    return !!path && workspacePathExcluded(path);
  });
  return result.sort();
}

export function workspaceRepositoryId(workspaceRoot: string): string {
  return createHash('sha256').update(normalizedIdentityPath(workspaceRoot)).digest('hex').slice(0, 24);
}

export function toGitPath(path: string): string {
  return path.split(sep).join('/');
}

export function manifestSummary(manifest: VersionCheckpointManifest): VersionCheckpointSummary {
  if (manifest.status === 'pending') throw new Error(`checkpoint ${manifest.id} is pending`);
  return {
    version: 1,
    id: manifest.id,
    reason: manifest.reason,
    status: manifest.status,
    createdAt: manifest.createdAt,
    dataCommit: manifest.data.commit,
    workspace: manifest.workspace ? {
      repositoryId: manifest.workspace.repositoryId,
      beforeCommit: manifest.workspace.beforeCommit,
      commit: manifest.workspace.commit,
      trackedPathCount: manifest.workspace.trackedPaths.length,
    } : undefined,
    warningCodes: [...manifest.warningCodes],
  };
}

export async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function listJsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => join(directory, entry.name));
  } catch {
    return [];
  }
}

export async function safeLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return (await safeLstat(path)) !== undefined;
}

async function walkFiles(
  root: string,
  visit: (path: string, info: Stats) => Promise<void>,
  skipDirectory: (path: string) => boolean = () => false,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!skipDirectory(path)) await walkFiles(path, visit, skipDirectory);
      continue;
    }
    if (!entry.isFile()) continue;
    await visit(path, await lstat(path) as Stats);
  }
}

function dataDirectoryExcluded(path: string): boolean {
  return path.includes('/backups/')
    || path.includes('/quarantine/')
    || path.includes('/stage-data/');
}

function dataFileExcluded(path: string): boolean {
  const lower = path.toLocaleLowerCase();
  return dataDirectoryExcluded(lower)
    || lower.endsWith('.sqlite')
    || lower.includes('.sqlite-')
    || lower.endsWith('.db')
    || lower.includes('.db-')
    || lower.endsWith('.tmp')
    || lower.endsWith('.temp')
    || lower.endsWith('.log');
}

function normalizedIdentityPath(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}
