import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { atomicWrite } from '@littlesheep/memory-core';
import {
  applyWorkspaceResourceChange,
  isWorkspacePathInside,
  normalizeWorkspaceRelativePath,
  scanWorkspaceResourceBatch,
  selectWorkspaceFiles,
  startWorkspaceScanGeneration,
} from './workspace-resource-scanner.js';

const WORKSPACE_RESOURCE_INDEX_VERSION = 1;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;

const DEFAULT_LIMITS: WorkspaceResourceIndexLimits = {
  maxFiles: 512,
  maxDirectoriesPerSync: 64,
  maxPendingDirectories: 512,
  maxEntriesPerDirectory: 512,
  maxDepth: 6,
  rescanIntervalMs: 60_000,
};

export type WorkspaceBoundaryKind = 'agent_workplace' | 'user_workplace' | 'project';
export type WorkspaceIndexedFileOwner = 'user' | 'agent';
export type WorkspaceIndexedFileKind = 'code' | 'text' | 'image' | 'document' | 'archive' | 'data' | 'other';

export interface WorkspaceResourceIndexLimits {
  maxFiles: number;
  maxDirectoriesPerSync: number;
  maxPendingDirectories: number;
  maxEntriesPerDirectory: number;
  maxDepth: number;
  rescanIntervalMs: number;
}

export interface WorkspaceResourceChange {
  path: string;
  source: WorkspaceIndexedFileOwner;
}

export interface WorkspaceResourceSyncOptions {
  boundaryKind?: WorkspaceBoundaryKind;
  projectId?: string;
  force?: boolean;
  changes?: WorkspaceResourceChange[];
}

export interface WorkspaceIndexedFile {
  relativePath: string;
  name: string;
  extension: string;
  kind: WorkspaceIndexedFileKind;
  size: number;
  mtimeMs: number;
  owner: WorkspaceIndexedFileOwner;
  generation: number;
}

export interface WorkspaceScanCursor {
  relativeDir: string;
  depth: number;
}

export interface WorkspaceResourceScanState {
  status: 'scanning' | 'complete' | 'missing';
  generation: number;
  queue: WorkspaceScanCursor[];
  startedAt?: string;
  completedAt?: string;
  lastSyncedAt: string;
  scannedDirectories: number;
  truncated: boolean;
}

export interface WorkspaceResourceIndexSnapshot {
  version: typeof WORKSPACE_RESOURCE_INDEX_VERSION;
  identity: string;
  workspacePath: string;
  boundaryKind: WorkspaceBoundaryKind;
  projectId?: string;
  files: WorkspaceIndexedFile[];
  scan: WorkspaceResourceScanState;
  updatedAt: string;
}

export interface WorkspaceResourceSyncResult {
  indexPath: string;
  snapshot: WorkspaceResourceIndexSnapshot;
  changed: boolean;
}

export interface WorkspaceResourceIndexStoreOptions {
  dataDir: string;
  limits?: Partial<WorkspaceResourceIndexLimits>;
  now?: () => number;
}

export class WorkspaceResourceIndexStore {
  readonly indexDir: string;

  private readonly limits: WorkspaceResourceIndexLimits;
  private readonly now: () => number;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: WorkspaceResourceIndexStoreOptions) {
    this.indexDir = resolve(options.dataDir, 'workspace', 'resource-indexes');
    this.limits = normalizeLimits(options.limits);
    this.now = options.now ?? Date.now;
  }

  async sync(workspace: string, options: WorkspaceResourceSyncOptions = {}): Promise<WorkspaceResourceSyncResult> {
    const root = resolve(workspace);
    const boundaryKind = options.boundaryKind ?? 'user_workplace';
    const identity = workspaceIdentity(root, boundaryKind, options.projectId);
    const indexPath = this.pathForIdentity(identity);
    return this.exclusive(indexPath, async () => {
      await mkdir(this.indexDir, { recursive: true });
      const now = this.now();
      const timestamp = new Date(now).toISOString();
      const prior = await this.read(indexPath, {
        identity,
        workspacePath: root,
        boundaryKind,
        projectId: options.projectId,
        timestamp,
      });
      const before = JSON.stringify(prior);
      prior.identity = identity;
      prior.workspacePath = root;
      prior.boundaryKind = boundaryKind;
      prior.projectId = options.projectId?.trim() || undefined;

      const rootInfo = await lstat(root).catch(() => undefined);
      const rootAvailable = !!rootInfo?.isDirectory() && !rootInfo.isSymbolicLink();
      if (!rootAvailable) {
        if (prior.scan.status !== 'missing' || prior.scan.queue.length > 0) {
          prior.scan = {
            ...prior.scan,
            status: 'missing',
            queue: [],
            completedAt: undefined,
            lastSyncedAt: timestamp,
          };
        }
      } else {
        const shouldContinue = prior.scan.status === 'scanning';
        const lastCompleted = prior.scan.completedAt ? Date.parse(prior.scan.completedAt) : 0;
        const due = options.force === true
          || prior.scan.status === 'missing'
          || !lastCompleted
          || now - lastCompleted >= this.limits.rescanIntervalMs;
        if (!shouldContinue && due) startWorkspaceScanGeneration(prior, timestamp);

        const activeGeneration = prior.scan.generation;
        let changedByHint = false;
        for (const change of options.changes ?? []) {
          changedByHint = await applyWorkspaceResourceChange(
            prior,
            root,
            change,
            activeGeneration,
            this.limits.maxFiles,
          ) || changedByHint;
        }
        if (prior.scan.status === 'scanning') {
          await scanWorkspaceResourceBatch(prior, root, timestamp, this.limits);
        } else if (changedByHint) {
          prior.scan.lastSyncedAt = timestamp;
        }
      }

      prior.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'));
      const changed = JSON.stringify(prior) !== before;
      if (changed) {
        prior.updatedAt = timestamp;
        await atomicWrite(indexPath, JSON.stringify(prior, null, 2));
      }
      return { indexPath, snapshot: structuredClone(prior), changed };
    });
  }

  async readSnapshot(indexPath: string): Promise<WorkspaceResourceIndexSnapshot | undefined> {
    const target = resolve(indexPath);
    if (!isWorkspacePathInside(this.indexDir, target)) return undefined;
    return this.exclusive(target, async () => this.readExisting(target));
  }

  async render(indexPath: string, query?: string, maxEntries = 200): Promise<string | undefined> {
    const snapshot = await this.readSnapshot(indexPath);
    if (!snapshot) return undefined;
    const selected = selectWorkspaceFiles(snapshot.files, query, maxEntries);
    const scope = snapshot.projectId ? `project:${snapshot.projectId}` : snapshot.boundaryKind;
    const lines = [
      `Workspace: ${snapshot.workspacePath}`,
      `Scope: ${scope}`,
      `Index state: ${snapshot.scan.status}; files=${snapshot.files.length}; truncated=${snapshot.scan.truncated}.`,
      query?.trim() ? `Filter: ${query.trim()}` : 'Filter: none',
      'File bodies are not loaded. Use read/glob/grep or the workspace tools only when the task needs content.',
      '',
      ...selected.map((file) => (
        `- ${file.relativePath} | ${file.kind} | ${file.size} bytes | owner=${file.owner} | mtime=${new Date(file.mtimeMs).toISOString()}`
      )),
    ];
    if (selected.length === 0) lines.push('- No indexed file matched the requested filter.');
    if (selected.length < snapshot.files.length) {
      lines.push(`... ${snapshot.files.length - selected.length} indexed file(s) omitted by the filter or display bound.`);
    }
    return lines.join('\n');
  }

  private async read(
    indexPath: string,
    fallback: {
      identity: string;
      workspacePath: string;
      boundaryKind: WorkspaceBoundaryKind;
      projectId?: string;
      timestamp: string;
    },
  ): Promise<WorkspaceResourceIndexSnapshot> {
    const existing = await this.readExisting(indexPath);
    return existing ?? emptySnapshot(fallback);
  }

  private async readExisting(indexPath: string): Promise<WorkspaceResourceIndexSnapshot | undefined> {
    let raw: string;
    try {
      const info = await lstat(indexPath);
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
      if (info.size > MAX_INDEX_BYTES) throw new Error('workspace resource index is too large');
      raw = await readFile(indexPath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      if (error instanceof Error && error.message === 'workspace resource index is too large') {
        await this.preserveCorruptIndex(indexPath);
        return undefined;
      }
      throw error;
    }
    try {
      return parseSnapshot(JSON.parse(raw) as unknown);
    } catch {
      await this.preserveCorruptIndex(indexPath);
      return undefined;
    }
  }

  private async preserveCorruptIndex(indexPath: string): Promise<void> {
    const backup = `${indexPath}.corrupt-${this.now()}-${randomUUID().slice(0, 8)}.json`;
    await copyFile(indexPath, backup).catch(() => undefined);
  }

  private pathForIdentity(identity: string): string {
    return join(this.indexDir, `${hashId(identity)}.json`);
  }

  private exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return result;
  }
}

function emptySnapshot(input: {
  identity: string;
  workspacePath: string;
  boundaryKind: WorkspaceBoundaryKind;
  projectId?: string;
  timestamp: string;
}): WorkspaceResourceIndexSnapshot {
  return {
    version: WORKSPACE_RESOURCE_INDEX_VERSION,
    identity: input.identity,
    workspacePath: input.workspacePath,
    boundaryKind: input.boundaryKind,
    projectId: input.projectId?.trim() || undefined,
    files: [],
    scan: {
      status: 'missing',
      generation: 0,
      queue: [],
      lastSyncedAt: input.timestamp,
      scannedDirectories: 0,
      truncated: false,
    },
    updatedAt: input.timestamp,
  };
}

function parseSnapshot(value: unknown): WorkspaceResourceIndexSnapshot {
  if (!value || typeof value !== 'object') throw new Error('workspace resource index must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.version !== WORKSPACE_RESOURCE_INDEX_VERSION) throw new Error('unsupported workspace resource index version');
  const identity = readString(raw.identity);
  const workspacePath = readString(raw.workspacePath);
  const boundaryKind = raw.boundaryKind;
  const updatedAt = readDate(raw.updatedAt);
  if (!identity || !workspacePath || !isBoundaryKind(boundaryKind) || !updatedAt) {
    throw new Error('invalid workspace resource index header');
  }
  const files = Array.isArray(raw.files)
    ? raw.files.map(parseIndexedFile).filter((file): file is WorkspaceIndexedFile => !!file).slice(0, DEFAULT_LIMITS.maxFiles * 2)
    : [];
  const scan = parseScanState(raw.scan, updatedAt);
  return {
    version: WORKSPACE_RESOURCE_INDEX_VERSION,
    identity,
    workspacePath,
    boundaryKind,
    projectId: readString(raw.projectId),
    files,
    scan,
    updatedAt,
  };
}

function parseIndexedFile(value: unknown): WorkspaceIndexedFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const relativePath = readString(raw.relativePath);
  const name = readString(raw.name);
  const extension = typeof raw.extension === 'string' ? raw.extension : '';
  const kind = raw.kind;
  const owner = raw.owner;
  const size = readNonNegativeNumber(raw.size);
  const mtimeMs = readNonNegativeNumber(raw.mtimeMs);
  const generation = readNonNegativeInteger(raw.generation);
  if (!relativePath || isAbsolute(relativePath) || relativePath.startsWith('..') || !name
    || !isFileKind(kind) || !isFileOwner(owner) || size === undefined || mtimeMs === undefined
    || generation === undefined) return undefined;
  return { relativePath, name, extension, kind, size, mtimeMs, owner, generation };
}

function parseScanState(value: unknown, fallbackDate: string): WorkspaceResourceScanState {
  if (!value || typeof value !== 'object') {
    return {
      status: 'missing',
      generation: 0,
      queue: [],
      lastSyncedAt: fallbackDate,
      scannedDirectories: 0,
      truncated: false,
    };
  }
  const raw = value as Record<string, unknown>;
  const status = raw.status === 'scanning' || raw.status === 'complete' || raw.status === 'missing'
    ? raw.status
    : 'missing';
  const queue = Array.isArray(raw.queue)
    ? raw.queue.map(parseCursor).filter((item): item is WorkspaceScanCursor => !!item).slice(0, DEFAULT_LIMITS.maxPendingDirectories)
    : [];
  return {
    status,
    generation: readNonNegativeInteger(raw.generation) ?? 0,
    queue,
    startedAt: readDate(raw.startedAt),
    completedAt: readDate(raw.completedAt),
    lastSyncedAt: readDate(raw.lastSyncedAt) ?? fallbackDate,
    scannedDirectories: readNonNegativeInteger(raw.scannedDirectories) ?? 0,
    truncated: raw.truncated === true,
  };
}

function parseCursor(value: unknown): WorkspaceScanCursor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const relativeDir = typeof raw.relativeDir === 'string' ? normalizeWorkspaceRelativePath(raw.relativeDir) : '';
  const depth = readNonNegativeInteger(raw.depth);
  if (depth === undefined || isAbsolute(relativeDir) || relativeDir.startsWith('..')) return undefined;
  return { relativeDir, depth };
}

function workspaceIdentity(root: string, kind: WorkspaceBoundaryKind, projectId?: string): string {
  if (kind === 'project' && projectId?.trim()) return `project:${projectId.trim()}`;
  if (kind === 'agent_workplace') return 'agent-workplace';
  return `workspace:${normalizedPath(root)}`;
}

function normalizedPath(value: string): string {
  return resolve(value).replace(/[\\/]+/gu, '/').replace(/\/$/u, '').toLocaleLowerCase();
}

function hashId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function normalizeLimits(value: Partial<WorkspaceResourceIndexLimits> | undefined): WorkspaceResourceIndexLimits {
  return {
    maxFiles: positiveLimit(value?.maxFiles, DEFAULT_LIMITS.maxFiles),
    maxDirectoriesPerSync: positiveLimit(value?.maxDirectoriesPerSync, DEFAULT_LIMITS.maxDirectoriesPerSync),
    maxPendingDirectories: positiveLimit(value?.maxPendingDirectories, DEFAULT_LIMITS.maxPendingDirectories),
    maxEntriesPerDirectory: positiveLimit(value?.maxEntriesPerDirectory, DEFAULT_LIMITS.maxEntriesPerDirectory),
    maxDepth: positiveLimit(value?.maxDepth, DEFAULT_LIMITS.maxDepth),
    rescanIntervalMs: nonNegativeLimit(value?.rescanIntervalMs, DEFAULT_LIMITS.rescanIntervalMs),
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readDate(value: unknown): string | undefined {
  const text = readString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isBoundaryKind(value: unknown): value is WorkspaceBoundaryKind {
  return value === 'agent_workplace' || value === 'user_workplace' || value === 'project';
}

function isFileOwner(value: unknown): value is WorkspaceIndexedFileOwner {
  return value === 'user' || value === 'agent';
}

function isFileKind(value: unknown): value is WorkspaceIndexedFileKind {
  return value === 'code' || value === 'text' || value === 'image' || value === 'document'
    || value === 'archive' || value === 'data' || value === 'other';
}

function isNodeError(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code;
}
