// @littlesheep/memory-tree - stable compatibility facade over versioned repository backends.

import { InjectionTier } from './types.js';
import type {
  MemoryBranchKind,
  MemoryManagementAction,
  MemoryManagementResult,
  MemoryMigrationRecord,
  MemoryNode,
  MemoryRecentNodeQuery,
  MemoryResourceManagementAction,
  MemoryResourceManagementAuditRecord,
  MemoryResourceManagementResult,
  MemoryResourceQuery,
  MemoryResourceRegistration,
  MemoryResourceRebindPatch,
  MemoryTreeDocument,
  MemoryWriteIntent,
  MemoryWriteResult,
} from './types.js';
import type {
  ManageMemoryResourceOptions,
  MemoryRepositoryBackendKind,
  MemoryRepositoryOptions,
  RebindMemoryResourceOptions,
  RemoveMemoryResourcesOptions,
  ReplaceMemoryResourceGroupOptions,
} from './memory-repository/contracts.js';
import { memoryBranchRootId } from './memory-repository/document-store.js';
import type { MemoryRepositoryBackend } from './memory-repository/backend.js';
import { createMemoryRepositoryBackend } from './memory-repository/factory.js';
import type { MemoryProjectRebindResult } from './memory-repository/project-rebinding.js';
import { createMemoryRepositoryRetrievalFacade, type MemoryRepositoryRetrievalFacade } from './memory-repository/retrieval-facade.js';
import { createMemoryRepositoryManagementFacade, type MemoryRepositoryManagementFacade } from './memory-repository/management.js';

export type {
  ManageMemoryResourceOptions,
  MemoryRepositoryOptions,
  MemoryWriteServiceOptions,
  RebindMemoryResourceOptions,
  RemoveMemoryResourcesOptions,
  ReplaceMemoryResourceGroupOptions,
  MemoryRepositoryBackendKind,
  MemoryV3ExperimentMarker,
  MemoryRepositoryV3Options,
} from './memory-repository/contracts.js';
export { MEMORY_V3_EXPERIMENT_MARKER } from './memory-repository/contracts.js';
export { createMemoryV3ExperimentMarker } from './memory-repository/factory.js';
export { MemoryWriteService } from './memory-repository/write-service.js';
export type { MemoryWriteServiceLike } from './memory-repository/write-service.js';

export class MemoryRepository {
  readonly rootDir: string;
  readonly indexPath: string;
  readonly backendKind: MemoryRepositoryBackendKind;
  readonly retrieval: MemoryRepositoryRetrievalFacade;
  readonly management: MemoryRepositoryManagementFacade;
  private readonly backend: MemoryRepositoryBackend;

  constructor(options: MemoryRepositoryOptions) {
    const selected = createMemoryRepositoryBackend(options);
    this.backendKind = selected.kind;
    this.backend = selected.backend;
    this.retrieval = createMemoryRepositoryRetrievalFacade(this.backend);
    this.management = createMemoryRepositoryManagementFacade(this.backend);
    this.rootDir = this.backend.rootDir;
    this.indexPath = this.backend.indexPath;
  }

  static branchRootId(branch: MemoryBranchKind): string { return memoryBranchRootId(branch); }

  evidenceLocator(nodeId: string): string {
    return this.backendKind === 'v3'
      ? `memory-v3:atom:${nodeId}`
      : `memory-tree/index.json#${nodeId}`;
  }

  initialize(): Promise<void> { return this.backend.initialize(); }

  snapshot(): Promise<MemoryTreeDocument> { return this.backend.snapshot(); }

  getResource(id: string): Promise<MemoryResourceRegistration | undefined> { return this.backend.getResource(id); }

  listResources(query: MemoryResourceQuery = {}): Promise<MemoryResourceRegistration[]> {
    return this.backend.listResources(query);
  }

  listResourceManagementAudit(
    resourceId?: string,
    limit = 100,
  ): Promise<MemoryResourceManagementAuditRecord[]> {
    return this.backend.listResourceManagementAudit(resourceId, limit);
  }

  replaceResourceGroup(
    registryGroup: string,
    resources: MemoryResourceRegistration[],
    options: ReplaceMemoryResourceGroupOptions = {},
  ): Promise<MemoryResourceRegistration[]> {
    return this.backend.replaceResourceGroup(registryGroup, resources, options);
  }

  manageResource(
    resourceId: string,
    action: Exclude<MemoryResourceManagementAction, 'rebind'>,
    options: ManageMemoryResourceOptions = {},
  ): Promise<MemoryResourceManagementResult | undefined> {
    return this.backend.manageResource(resourceId, action, options);
  }

  rebindResource(
    resourceId: string,
    patch: MemoryResourceRebindPatch,
    options: RebindMemoryResourceOptions = {},
  ): Promise<MemoryResourceManagementResult | undefined> {
    return this.backend.rebindResource(resourceId, patch, options);
  }

  removeResources(
    query: MemoryResourceQuery,
    options: RemoveMemoryResourcesOptions = {},
  ): Promise<number> {
    return this.backend.removeResources(query, options);
  }

  restoreSchemaBackup(backupFile: string): Promise<void> { return this.backend.restoreSchemaBackup(backupFile); }

  getNode(id: string): Promise<MemoryNode | undefined> { return this.backend.getNode(id); }

  listNodes(branch: MemoryBranchKind, scopeKey?: string): Promise<MemoryNode[]> {
    return this.backend.listNodes(branch, scopeKey);
  }

  listRecentNodes(branch: MemoryBranchKind, query: MemoryRecentNodeQuery = {}): Promise<MemoryNode[]> { return this.backend.listRecentNodes(branch, query); }

  rebindProjectPath(fromPath: string, toPath: string): Promise<MemoryProjectRebindResult> {
    return this.backend.rebindProjectPath(fromPath, toPath);
  }

  children(parentNodeId: string): Promise<MemoryNode[]> { return this.backend.children(parentNodeId); }

  write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> { return this.backend.write(intent); }
  recordMemoryFeedback(feedbacks: import('./v3/contracts.js').MemoryUseFeedback[]): Promise<import('./v3/contracts.js').MemoryAtom[]> { return this.backend.recordMemoryFeedback(feedbacks); }

  retryRecoveryQueue(limit = 20): Promise<MemoryWriteResult[]> {
    return this.backend.retryRecoveryQueue(limit);
  }

  setStatus(nodeId: string, status: MemoryNode['status']): Promise<MemoryNode | undefined> {
    return this.backend.setStatus(nodeId, status);
  }

  changeTier(nodeId: string, tier: InjectionTier): Promise<MemoryNode | undefined> {
    return this.backend.changeTier(nodeId, tier);
  }

  manageNode(nodeId: string, action: MemoryManagementAction,
    reason = 'Changed by the user from the memory-tree management page.', expectedRevision?: number,
  ): Promise<MemoryManagementResult | undefined> {
    return this.backend.manageNode(nodeId, action, reason, expectedRevision);
  }

  getMigration(id: string): Promise<MemoryMigrationRecord | undefined> { return this.backend.getMigration(id); }

  markMigration(record: MemoryMigrationRecord): Promise<void> {
    return this.backend.markMigration(record);
  }
  startBackgroundMaintenance(): Promise<void> { return this.backend.startBackgroundMaintenance?.() ?? Promise.resolve(); }
  async shutdown(): Promise<void> { if (this.backend.shutdown) await this.backend.shutdown(); else this.backend.close?.(); }
  close(): void { if ('close' in this.backend && typeof this.backend.close === 'function') this.backend.close(); }
}
