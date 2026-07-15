// Implements the user-facing resource control plane without owning repository persistence.

import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type {
  MemoryResourceManagementAction,
  MemoryResourceManagementResult,
  MemoryResourceQuery,
  MemoryResourceRegistration,
} from '../types.js';
import type { MemoryRepository } from '../memory-repository.js';
import type { MemoryTree } from '../memory-tree.js';
import type { MemoryManagementSnapshot } from './contracts.js';
import {
  contentHash,
  documentKind,
  isWorkspaceDocument,
  pathInsideOrSame,
} from './resource-identifiers.js';
import type { SessionSummaryResourceCoordinator } from './summary-resources.js';
import type { WorkspaceDocumentCoordinator } from './workspace-documents.js';

export class MemoryResourceManagementCoordinator {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly tree: MemoryTree,
    private readonly summaries: SessionSummaryResourceCoordinator,
    private readonly workspaceDocuments: WorkspaceDocumentCoordinator,
  ) {}

  list(query: MemoryResourceQuery = {}): Promise<MemoryResourceRegistration[]> {
    return this.repository.listResources(query);
  }

  async manage(
    resourceId: string,
    action: Extract<MemoryResourceManagementAction, 'disable' | 'restore' | 'remove'>,
    reason?: string,
  ): Promise<MemoryResourceManagementResult | undefined> {
    const resource = await this.repository.getResource(resourceId);
    if (!resource) return undefined;
    this.assertUserManageable(resource);

    if (action === 'restore') {
      const observedStatus = await this.observeStatus(resource);
      if (observedStatus !== 'active') {
        throw new Error('资源来源仍不可用，请先恢复来源或重新定位资源。');
      }
      return this.repository.manageResource(resourceId, action, {
        actor: 'user',
        reason: reason ?? '用户恢复了已登记的记忆资源。',
        restoreStatus: observedStatus,
      });
    }
    return this.repository.manageResource(resourceId, action, {
      actor: 'user',
      reason: reason ?? (action === 'disable'
        ? '用户停用了已登记的记忆资源。'
        : '用户移除了非活动记忆资源的登记，来源文件未被删除。'),
    });
  }

  async rebindSource(
    resourceId: string,
    sourcePath: string,
    reason?: string,
  ): Promise<MemoryResourceManagementResult | undefined> {
    const resource = await this.repository.getResource(resourceId);
    if (!resource) return undefined;
    this.assertUserManageable(resource);
    if (resource.source.kind !== 'file' || !resource.registryGroup.startsWith('workspace-docs:')) {
      throw new Error('此控制面只能重新定位已登记的工作区文档。');
    }
    if (resource.scope !== 'workspace' || !resource.scopeKey) {
      throw new Error('该资源没有已授权的工作区边界。');
    }

    const target = resolve(sourcePath);
    if (!pathInsideOrSame(resource.scopeKey, target)) {
      throw new Error('重新定位后的资源必须保留在其已授权工作区内。');
    }
    if (!target.toLocaleLowerCase().endsWith('.md') || !isWorkspaceDocument(basename(target))) {
      throw new Error('所选文件不是受支持的工作区规范、任务书、架构文档或 README。');
    }
    const targetStat = await stat(target).catch(() => undefined);
    if (!targetStat?.isFile()) throw new Error('所选资源文件不存在。');
    const body = await readFile(target, 'utf8');
    const kind = documentKind(basename(target));
    const rebound = await this.repository.rebindResource(resourceId, {
      sourcePath: target,
      title: basename(target),
      kind,
      indexKeys: [basename(target), kind, basename(resource.scopeKey)],
      contentHash: contentHash(body),
      status: 'active',
    }, {
      actor: 'user',
      reason: reason ?? '资源来源移动或重命名后，用户重新定位了工作区记忆资源。',
      replaceConflictingResource: true,
    });
    await this.workspaceDocuments.sync(resource.scopeKey);
    return rebound;
  }

  async snapshot(): Promise<MemoryManagementSnapshot> {
    const [document, resources] = await Promise.all([
      this.repository.snapshot(),
      this.repository.listResources(),
    ]);
    return {
      document,
      branches: this.tree.list(),
      ledgers: this.tree.listLedgers(80),
      resources,
    };
  }

  private assertUserManageable(resource: MemoryResourceRegistration): void {
    if (resource.scope === 'run') {
      throw new Error('Run-scoped resources are managed automatically and expire when the run finishes.');
    }
    if (resource.kind === 'project-memory-projection') {
      throw new Error('Use the project memory projection controls for this resource.');
    }
    if (resource.kind === 'workspace-index') {
      throw new Error('工作区资源索引由运行时自动维护，不能从记忆资源控制面修改。');
    }
    if (resource.owner?.controller === 'plugin-host') {
      throw new Error('该 Skill 由插件宿主管理，请在插件页面更改其状态。');
    }
    if (resource.owner?.controller === 'skill-loader') {
      throw new Error('该 Skill 由技能配置管理，请在技能页面更改其状态。');
    }
  }

  private async observeStatus(resource: MemoryResourceRegistration): Promise<'active' | 'missing'> {
    if (resource.source.kind === 'file') {
      const sourcePath = resource.source.path;
      if (!sourcePath) return 'missing';
      const sourceStat = await stat(sourcePath).catch(() => undefined);
      return sourceStat?.isFile() ? 'active' : 'missing';
    }
    return this.summaries.observe(resource);
  }
}
