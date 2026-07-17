// Coordinates two-phase data/workspace checkpoints and rollback transactions.
// Filesystem policy and manifest codecs live in git-checkpoint-files.ts; raw
// Git plumbing remains isolated in git-client.ts.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  VersionCheckpointManifest,
  VersionCheckpointSummary,
} from '@littlesheep/types';
import { ShadowGitRepository } from './git-client.js';
import {
  DEFAULT_MAX_CHECKPOINTS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_WORKSPACE_BYTES,
  DEFAULT_MAX_WORKSPACE_FILES,
  atomicJsonWrite,
  collectDataFiles,
  isManagedDataPath,
  listJsonFiles,
  manifestSummary,
  pathExists,
  safeLstat,
  toGitPath,
  walkWorkspaceFiles,
  workspacePathExcluded,
  workspaceRepositoryId,
} from './git-checkpoint-files.js';

export interface GitCheckpointCoordinatorOptions {
  dataRoot: string;
  maxCheckpoints?: number;
  maxFileBytes?: number;
  maxWorkspaceFiles?: number;
  maxWorkspaceBytes?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface BeginRunCheckpointOptions {
  runId: string;
  workspaceRoot: string;
}

export interface CompleteRunCheckpointOptions {
  sessionId?: string;
  status?: 'complete' | 'partial';
  warningCodes?: readonly string[];
}

export interface RollbackCheckpointOptions {
  position?: 'before' | 'after';
}

export interface VersioningMutationHook {
  beforeFileMutation(filePath: string): Promise<void>;
  beforeWorkspaceMutation(workspacePath: string): Promise<void>;
}

export class RunGitCheckpoint implements VersioningMutationHook {
  readonly id: string;
  readonly runId: string;
  readonly workspaceRoot: string;
  private readonly coordinator: GitCheckpointCoordinator;
  private readonly workspaceRepository: ShadowGitRepository;
  private readonly workspaceRepositoryId: string;
  private readonly touchedPaths = new Set<string>();
  private workspaceBeforeCommit?: string;
  private fullWorkspaceCaptured = false;
  private settled = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    coordinator: GitCheckpointCoordinator,
    manifest: VersionCheckpointManifest,
    workspaceRoot: string,
    repository: ShadowGitRepository,
  ) {
    this.coordinator = coordinator;
    this.id = manifest.id;
    this.runId = manifest.runId!;
    this.workspaceRoot = workspaceRoot;
    this.workspaceRepository = repository;
    this.workspaceRepositoryId = manifest.workspace!.repositoryId;
  }

  async beforeFileMutation(filePath: string): Promise<void> {
    return this.enqueueMutation(async () => {
      this.assertOpen();
      const path = await this.coordinator.resolveWorkspaceFile(this.workspaceRoot, filePath);
      if (this.touchedPaths.has(path)) return;
      const commit = await this.workspaceRepository.commitPaths(
        [path],
        `preimage ${this.runId} ${path}`,
        true,
      );
      this.workspaceBeforeCommit = commit ?? this.workspaceBeforeCommit;
      this.touchedPaths.add(path);
      await this.coordinator.updatePendingWorkspace(this, this.snapshotWorkspace());
    });
  }

  async beforeWorkspaceMutation(workspacePath: string): Promise<void> {
    return this.enqueueMutation(async () => {
      this.assertOpen();
      this.coordinator.assertInsideWorkspace(this.workspaceRoot, workspacePath);
      if (this.fullWorkspaceCaptured) return;
      const paths = await this.coordinator.collectWorkspaceFiles(this.workspaceRoot);
      const tracked = await this.workspaceRepository.trackedPaths();
      const managed = [...new Set([...paths, ...tracked])];
      const commit = await this.workspaceRepository.commitPaths(
        managed,
        `workspace preimage ${this.runId}`,
        true,
      );
      this.workspaceBeforeCommit = commit ?? this.workspaceBeforeCommit;
      for (const path of managed) this.touchedPaths.add(path);
      this.fullWorkspaceCaptured = true;
      await this.coordinator.updatePendingWorkspace(this, this.snapshotWorkspace());
    });
  }

  async complete(options: CompleteRunCheckpointOptions = {}): Promise<VersionCheckpointSummary> {
    await this.mutationQueue;
    this.assertOpen();
    const summary = await this.coordinator.completeRun(this, options);
    this.settled = true;
    return summary;
  }

  async abort(warningCode = 'run-ended-before-checkpoint-complete'): Promise<VersionCheckpointSummary> {
    if (this.settled) return this.coordinator.summary(this.id);
    return this.complete({ status: 'partial', warningCodes: [warningCode] });
  }

  workspacePaths(): string[] {
    return [...this.touchedPaths].sort();
  }

  shouldScanWorkspaceOnComplete(): boolean {
    return this.fullWorkspaceCaptured;
  }

  workspaceBefore(): string | undefined {
    return this.workspaceBeforeCommit;
  }

  workspaceRepo(): ShadowGitRepository {
    return this.workspaceRepository;
  }

  repositoryId(): string {
    return this.workspaceRepositoryId;
  }

  private snapshotWorkspace(): NonNullable<VersionCheckpointManifest['workspace']> {
    return {
      repositoryId: this.workspaceRepositoryId,
      beforeCommit: this.workspaceBeforeCommit,
      trackedPaths: this.workspacePaths(),
    };
  }

  private assertOpen(): void {
    if (this.settled) throw new Error(`checkpoint ${this.id} is already settled`);
  }

  private enqueueMutation(operation: () => Promise<void>): Promise<void> {
    const next = this.mutationQueue.catch(() => undefined).then(operation);
    this.mutationQueue = next;
    return next;
  }
}

export class GitCheckpointCoordinator {
  readonly dataRoot: string;
  readonly versionRoot: string;
  private readonly manifestsDir: string;
  private readonly dataRepository: ShadowGitRepository;
  private readonly maxCheckpoints: number;
  private readonly maxFileBytes: number;
  private readonly maxWorkspaceFiles: number;
  private readonly maxWorkspaceBytes: number;
  private readonly log?: GitCheckpointCoordinatorOptions['log'];
  private initialized = false;
  private initializePromise?: Promise<VersionCheckpointSummary>;
  private readonly workspaces = new Map<string, ShadowGitRepository>();

  constructor(options: GitCheckpointCoordinatorOptions) {
    this.dataRoot = resolve(options.dataRoot);
    this.versionRoot = join(this.dataRoot, 'backups', 'versioning');
    this.manifestsDir = join(this.versionRoot, 'checkpoints');
    this.maxCheckpoints = Math.max(16, options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS);
    this.maxFileBytes = Math.max(1024, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    this.maxWorkspaceFiles = Math.max(100, options.maxWorkspaceFiles ?? DEFAULT_MAX_WORKSPACE_FILES);
    this.maxWorkspaceBytes = Math.max(this.maxFileBytes, options.maxWorkspaceBytes ?? DEFAULT_MAX_WORKSPACE_BYTES);
    this.log = options.log;
    this.dataRepository = new ShadowGitRepository({
      gitDir: join(this.versionRoot, 'repositories', 'data.git'),
      workTree: this.dataRoot,
      excludePatterns: [
        'backups/', 'attachment-cache/', 'config/keys.json', 'execution-logs/',
        'models/', 'plugin-data/', 'plugins/', 'quarantine/', 'vectors/',
        '*.sqlite', '*.sqlite-*', '*.db', '*.db-*', '*.tmp', '*.temp', '*.log',
      ],
    });
  }

  initialize(): Promise<VersionCheckpointSummary> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeInternal();
    return this.initializePromise;
  }

  async beginRun(options: BeginRunCheckpointOptions): Promise<RunGitCheckpoint> {
    await this.initialize();
    const workspaceRoot = resolve(options.workspaceRoot);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const dataPaths = await this.dataManagedPaths();
    const dataBeforeCommit = await this.dataRepository.commitPaths(
      dataPaths,
      `data preimage ${options.runId}`,
    );
    const repositoryId = workspaceRepositoryId(workspaceRoot);
    const workspaceRepository = this.workspaceRepository(workspaceRoot, repositoryId);
    const manifest: VersionCheckpointManifest = {
      version: 1,
      id,
      reason: 'run-complete',
      status: 'pending',
      createdAt,
      runId: options.runId,
      data: {
        repositoryId: 'littlesheep-data',
        beforeCommit: dataBeforeCommit,
        trackedPathCount: dataPaths.length,
      },
      workspace: {
        repositoryId,
        trackedPaths: [],
      },
      warningCodes: [],
    };
    await this.writeManifest(manifest);
    return new RunGitCheckpoint(this, manifest, workspaceRoot, workspaceRepository);
  }

  async freeze(): Promise<VersionCheckpointSummary> {
    await this.initialize();
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const dataPaths = await this.dataManagedPaths();
    const dataCommit = await this.dataRepository.commitPaths(dataPaths, `shutdown freeze ${createdAt}`);
    const manifest: VersionCheckpointManifest = {
      version: 1,
      id,
      reason: 'shutdown-freeze',
      status: 'complete',
      createdAt,
      completedAt: new Date().toISOString(),
      data: {
        repositoryId: 'littlesheep-data',
        commit: dataCommit,
        trackedPathCount: dataPaths.length,
      },
      warningCodes: [],
    };
    await this.writeManifest(manifest);
    await this.pruneManifests();
    return manifestSummary(manifest);
  }

  async rollback(
    checkpointId: string,
    options: RollbackCheckpointOptions = {},
  ): Promise<VersionCheckpointSummary> {
    await this.initialize();
    const target = await this.readManifest(checkpointId);
    const position = options.position ?? 'after';
    const targetDataCommit = position === 'before' ? target.data.beforeCommit : target.data.commit;
    if (target.status === 'pending' || !targetDataCommit) {
      throw new Error(`checkpoint ${checkpointId} is not restorable`);
    }
    const dataBeforeCommit = await this.dataRepository.head();
    await this.dataRepository.restore(targetDataCommit, ['.']);
    const dataCommit = await this.dataRepository.commitPaths(
      await this.dataManagedPaths(),
      `rollback data to ${checkpointId}`,
      true,
    );
    let workspace: VersionCheckpointManifest['workspace'];
    const warningCodes = ['memory-catalog-rebuild-required'];
    const targetWorkspaceCommit = position === 'before'
      ? target.workspace?.beforeCommit
      : target.workspace?.commit;
    if (targetWorkspaceCommit && target.workspace) {
      const workspaceRoot = await this.workspaceRootForRepository(target.workspace.repositoryId);
      if (workspaceRoot) {
        const repository = this.workspaceRepository(workspaceRoot, target.workspace.repositoryId);
        const workspaceBeforeCommit = await repository.head();
        await repository.restore(targetWorkspaceCommit, ['.']);
        const tracked = await repository.trackedPaths();
        const commit = await repository.commitPaths(tracked, `rollback workspace to ${checkpointId}`, true);
        workspace = {
          repositoryId: target.workspace.repositoryId,
          beforeCommit: workspaceBeforeCommit,
          commit,
          trackedPaths: tracked,
        };
      } else {
        warningCodes.push('workspace-root-unavailable');
      }
    }
    const manifest: VersionCheckpointManifest = {
      version: 1,
      id: randomUUID(),
      reason: 'rollback',
      status: warningCodes.length > 1 ? 'partial' : 'complete',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      rollbackOf: checkpointId,
      data: {
        repositoryId: 'littlesheep-data',
        beforeCommit: dataBeforeCommit,
        commit: dataCommit,
        trackedPathCount: (await this.dataRepository.trackedPaths()).length,
      },
      workspace,
      warningCodes,
    };
    await this.writeManifest(manifest);
    await this.pruneManifests();
    return manifestSummary(manifest);
  }

  async resolveWorkspaceFile(workspaceRoot: string, filePath: string): Promise<string> {
    const root = resolve(workspaceRoot);
    const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
    this.assertInsideWorkspace(root, absolute);
    const info = await safeLstat(absolute);
    if (info?.isSymbolicLink()) throw new Error(`versioning refuses symbolic-link mutation: ${absolute}`);
    if (info?.isFile() && info.size > this.maxFileBytes) {
      throw new Error(`versioning file exceeds ${this.maxFileBytes} bytes: ${absolute}`);
    }
    const path = toGitPath(relative(root, absolute));
    if (!path || path === '.') throw new Error('versioning cannot mutate the workspace root itself');
    if (workspacePathExcluded(path)) throw new Error(`versioning excludes protected workspace path: ${path}`);
    return path;
  }

  assertInsideWorkspace(workspaceRoot: string, path: string): void {
    const root = resolve(workspaceRoot);
    const target = resolve(path);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`versioning path escapes workspace: ${target}`);
    }
  }

  async collectWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
    return walkWorkspaceFiles(
      workspaceRoot,
      this.maxFileBytes,
      this.maxWorkspaceFiles,
      this.maxWorkspaceBytes,
    );
  }

  async updatePendingWorkspace(
    checkpoint: RunGitCheckpoint,
    workspace: NonNullable<VersionCheckpointManifest['workspace']>,
  ): Promise<void> {
    const manifest = await this.readManifest(checkpoint.id);
    if (manifest.status !== 'pending') return;
    await this.writeManifest({ ...manifest, workspace });
  }

  async completeRun(
    checkpoint: RunGitCheckpoint,
    options: CompleteRunCheckpointOptions,
  ): Promise<VersionCheckpointSummary> {
    const pending = await this.readManifest(checkpoint.id);
    const workspacePaths = checkpoint.shouldScanWorkspaceOnComplete()
      ? [...new Set([
          ...checkpoint.workspacePaths(),
          ...await this.collectWorkspaceFiles(checkpoint.workspaceRoot),
          ...await checkpoint.workspaceRepo().trackedPaths(),
        ])].sort()
      : checkpoint.workspacePaths();
    let workspaceCommit: string | undefined;
    if (workspacePaths.length > 0) {
      workspaceCommit = await checkpoint.workspaceRepo().commitPaths(
        workspacePaths,
        `workspace run ${checkpoint.runId}`,
        true,
      );
      await this.writeWorkspaceLocator(checkpoint.repositoryId(), checkpoint.workspaceRoot);
    }
    const dataPaths = await this.dataManagedPaths();
    const dataCommit = await this.dataRepository.commitPaths(
      dataPaths,
      `data run ${checkpoint.runId}`,
      true,
    );
    const warningCodes = [...new Set(options.warningCodes ?? [])];
    const manifest: VersionCheckpointManifest = {
      ...pending,
      status: options.status ?? (warningCodes.length > 0 ? 'partial' : 'complete'),
      completedAt: new Date().toISOString(),
      sessionId: options.sessionId,
      data: {
        ...pending.data,
        commit: dataCommit,
        trackedPathCount: dataPaths.length,
      },
      workspace: workspacePaths.length > 0 ? {
        repositoryId: checkpoint.repositoryId(),
        beforeCommit: checkpoint.workspaceBefore(),
        commit: workspaceCommit,
        trackedPaths: workspacePaths,
      } : undefined,
      warningCodes,
    };
    await this.writeManifest(manifest);
    await this.pruneManifests();
    return manifestSummary(manifest);
  }

  async summary(checkpointId: string): Promise<VersionCheckpointSummary> {
    const manifest = await this.readManifest(checkpointId);
    if (manifest.status === 'pending') throw new Error(`checkpoint ${checkpointId} is pending`);
    return manifestSummary(manifest);
  }

  private async initializeInternal(): Promise<VersionCheckpointSummary> {
    await mkdir(this.manifestsDir, { recursive: true });
    await this.dataRepository.initialize();
    await this.recoverPendingManifests();
    const createdAt = new Date().toISOString();
    const paths = await this.dataManagedPaths();
    const commit = await this.dataRepository.commitPaths(paths, `bootstrap ${createdAt}`, true);
    const manifest: VersionCheckpointManifest = {
      version: 1,
      id: randomUUID(),
      reason: 'bootstrap',
      status: 'complete',
      createdAt,
      completedAt: new Date().toISOString(),
      data: {
        repositoryId: 'littlesheep-data',
        commit,
        trackedPathCount: paths.length,
      },
      warningCodes: [],
    };
    await this.writeManifest(manifest);
    await this.pruneManifests();
    this.initialized = true;
    return manifestSummary(manifest);
  }

  private workspaceRepository(root: string, repositoryId: string): ShadowGitRepository {
    const existing = this.workspaces.get(repositoryId);
    if (existing) return existing;
    const repository = new ShadowGitRepository({
      gitDir: join(this.versionRoot, 'repositories', 'workspaces', `${repositoryId}.git`),
      workTree: root,
      excludePatterns: [
        '.git/', '.hg/', '.svn/', '.env', '.env.*', 'node_modules/',
        'coverage/', 'dist/', 'out/', 'build/', 'release/', '*.log', '*.tmp', '*.temp',
      ],
    });
    this.workspaces.set(repositoryId, repository);
    return repository;
  }

  private async dataManagedPaths(): Promise<string[]> {
    const current = await collectDataFiles(this.dataRoot, this.maxFileBytes);
    const tracked = this.initialized || await pathExists(join(this.dataRepository.gitDir, 'HEAD'))
      ? await this.dataRepository.trackedPaths().catch(() => [])
      : [];
    return [...new Set([...current, ...tracked.filter(isManagedDataPath)])].sort();
  }

  private manifestPath(id: string): string {
    return join(this.manifestsDir, `${id}.json`);
  }

  private async writeManifest(manifest: VersionCheckpointManifest): Promise<void> {
    await atomicJsonWrite(this.manifestPath(manifest.id), manifest);
  }

  private async readManifest(id: string): Promise<VersionCheckpointManifest> {
    const parsed = JSON.parse(await readFile(this.manifestPath(id), 'utf8')) as VersionCheckpointManifest;
    if (parsed.version !== 1 || parsed.id !== id) throw new Error(`invalid checkpoint manifest ${id}`);
    return parsed;
  }

  private async recoverPendingManifests(): Promise<void> {
    for (const file of await listJsonFiles(this.manifestsDir)) {
      try {
        const manifest = JSON.parse(await readFile(file, 'utf8')) as VersionCheckpointManifest;
        if (manifest.version !== 1 || manifest.status !== 'pending') continue;
        await atomicJsonWrite(file, {
          ...manifest,
          status: 'partial',
          completedAt: new Date().toISOString(),
          warningCodes: [...new Set([...manifest.warningCodes, 'recovered-incomplete-checkpoint'])],
        } satisfies VersionCheckpointManifest);
      } catch (error) {
        this.log?.('warn', `versioning: failed to recover pending manifest ${file}: ${(error as Error).message}`);
      }
    }
  }

  private async pruneManifests(): Promise<void> {
    const files = await listJsonFiles(this.manifestsDir);
    if (files.length <= this.maxCheckpoints) return;
    const sorted = await Promise.all(files.map(async (file) => ({ file, modified: (await stat(file)).mtimeMs })));
    sorted.sort((left, right) => right.modified - left.modified);
    await Promise.all(sorted.slice(this.maxCheckpoints).map((entry) => rm(entry.file, { force: true })));
  }

  private async writeWorkspaceLocator(repositoryId: string, workspaceRoot: string): Promise<void> {
    await atomicJsonWrite(join(this.versionRoot, 'workspace-locators', `${repositoryId}.json`), {
      version: 1,
      repositoryId,
      workspaceRoot: resolve(workspaceRoot),
      updatedAt: new Date().toISOString(),
    });
  }

  private async workspaceRootForRepository(repositoryId: string): Promise<string | undefined> {
    try {
      const value = JSON.parse(await readFile(
        join(this.versionRoot, 'workspace-locators', `${repositoryId}.json`),
        'utf8',
      )) as { version?: number; repositoryId?: string; workspaceRoot?: string };
      if (value.version !== 1 || value.repositoryId !== repositoryId || !value.workspaceRoot) return undefined;
      return resolve(value.workspaceRoot);
    } catch {
      return undefined;
    }
  }
}
