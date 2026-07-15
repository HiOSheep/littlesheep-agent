// Serializes bounded workspace scans and exposes their metadata index through one resource.

import { basename } from 'node:path';
import { InjectionTier } from '../types.js';
import type { MemoryResourceRegistration } from '../types.js';
import type { MemoryRepository } from '../memory-repository.js';
import {
  WorkspaceResourceIndexStore,
  type WorkspaceResourceIndexLimits,
  type WorkspaceResourceSyncOptions,
  type WorkspaceResourceSyncResult,
} from '../workspace-resource-index.js';
import {
  hashId,
  normalizedPath,
  workspaceIndexRegistryGroup,
} from './resource-identifiers.js';

export class WorkspaceIndexResourceCoordinator {
  private readonly indexes: WorkspaceResourceIndexStore;
  private readonly syncQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: MemoryRepository,
    dataDir: string,
    limits?: Partial<WorkspaceResourceIndexLimits>,
  ) {
    this.indexes = new WorkspaceResourceIndexStore({ dataDir, limits });
  }

  sync(
    workspace: string,
    options: WorkspaceResourceSyncOptions = {},
  ): Promise<WorkspaceResourceSyncResult> {
    const key = options.projectId?.trim()
      ? `project:${options.projectId.trim()}`
      : normalizedPath(workspace);
    return this.serialize(key, () => this.syncUnlocked(workspace, options));
  }

  async resolve(
    resource: MemoryResourceRegistration,
    query?: string,
  ): Promise<{ content: string; source: string; generatedAt: string } | undefined> {
    if (resource.source.kind !== 'workspace-index' || !resource.source.path) return undefined;
    const content = await this.indexes.render(resource.source.path, query);
    if (!content) return undefined;
    return {
      content,
      source: `workspace:${resource.scopeKey ?? resource.source.id ?? 'unknown'}#resource-index`,
      generatedAt: resource.updatedAt,
    };
  }

  private async syncUnlocked(
    workspace: string,
    options: WorkspaceResourceSyncOptions,
  ): Promise<WorkspaceResourceSyncResult> {
    const result = await this.indexes.sync(workspace, options);
    const snapshot = result.snapshot;
    const group = workspaceIndexRegistryGroup(snapshot.identity);
    const existing = await this.repository.listResources({ registryGroup: group });
    const prior = existing.find((resource) => resource.kind === 'workspace-index');
    const rootName = basename(snapshot.workspacePath) || snapshot.workspacePath;
    const status = snapshot.scan.status === 'missing' ? 'missing' : 'active';
    if (!result.changed
      && prior
      && prior.status === status
      && prior.scopeKey
      && normalizedPath(prior.scopeKey) === normalizedPath(snapshot.workspacePath)) {
      return result;
    }
    const resource: MemoryResourceRegistration = {
      version: 1,
      id: prior?.id ?? `workspace-index:${hashId(snapshot.identity)}`,
      kind: 'workspace-index',
      title: `工作区资源索引：${rootName}`,
      description: `登记 ${snapshot.files.length} 个文件的路径与元数据；文件正文不会因建立索引而进入上下文。`,
      tier: InjectionTier.T2_RELEVANT,
      branch: 'project',
      scope: 'workspace',
      scopeKey: snapshot.workspacePath,
      authority: 'derived',
      privacy: snapshot.boundaryKind === 'project' ? 'project-private' : 'private',
      source: { kind: 'workspace-index', id: snapshot.identity, path: result.indexPath },
      indexKeys: [
        'workspace index',
        '工作区文件索引',
        rootName,
        snapshot.boundaryKind,
        ...snapshot.files.slice(0, 24).map((file) => file.relativePath),
      ],
      status,
      registryGroup: group,
      registeredAt: prior?.registeredAt ?? snapshot.updatedAt,
      updatedAt: snapshot.updatedAt,
      metadata: {
        workspacePath: snapshot.workspacePath,
        boundaryKind: snapshot.boundaryKind,
        projectId: snapshot.projectId,
        fileCount: snapshot.files.length,
        scanStatus: snapshot.scan.status,
        scanGeneration: snapshot.scan.generation,
        truncated: snapshot.scan.truncated,
        completedAt: snapshot.scan.completedAt,
      },
    };
    await this.repository.replaceResourceGroup(group, [resource], {
      preserveDisabled: false,
      staleMode: 'remove',
      reason: '工作区资源索引已按有界扫描结果同步。',
    });
    return result;
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.syncQueues.get(key) ?? Promise.resolve();
    const result = prior.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.syncQueues.set(key, settled);
    void settled.then(() => {
      if (this.syncQueues.get(key) === settled) this.syncQueues.delete(key);
    });
    return result;
  }
}
