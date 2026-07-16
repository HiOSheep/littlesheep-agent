// Owns the legacy v2 document-backed implementation behind the stable repository port.

import type { InjectionTier } from '../types.js';
import type {
  MemoryBranchKind,
  MemoryManagementAction,
  MemoryManagementResult,
  MemoryMigrationRecord,
  MemoryNode,
  MemoryResourceManagementAction,
  MemoryResourceManagementAuditRecord,
  MemoryResourceManagementResult,
  MemoryResourceQuery,
  MemoryResourceRegistration,
  MemoryResourceRebindPatch,
  MemoryTreeDocument,
  MemoryWriteIntent,
  MemoryWritePolicy,
  MemoryWriteResult,
} from '../types.js';
import { MemoryDocumentStore } from './document-store.js';
import { MemoryNodeStore } from './node-store.js';
import { rebindMemoryProjectPath, type MemoryProjectRebindResult } from './project-rebinding.js';
import { MemoryResourceStore } from './resource-store.js';
import type {
  ManageMemoryResourceOptions,
  RebindMemoryResourceOptions,
  RemoveMemoryResourcesOptions,
  ReplaceMemoryResourceGroupOptions,
} from './contracts.js';
import type { MemoryRepositoryBackend } from './backend.js';
import type {
  MemoryRepositoryManagementStatus,
  MemoryRepositoryNodeInspection,
} from './management.js';
import type { MemoryAtom, MemoryUseFeedback } from '../v3/contracts.js';

export interface MemoryRepositoryV2BackendOptions {
  dataDir: string;
  policy: MemoryWritePolicy;
  log?: ConstructorParameters<typeof MemoryDocumentStore>[0]['log'];
}

export class MemoryRepositoryV2Backend implements MemoryRepositoryBackend {
  readonly rootDir: string;
  readonly indexPath: string;
  private readonly policy: MemoryWritePolicy;
  private readonly documents: MemoryDocumentStore;
  private readonly resources: MemoryResourceStore;
  private readonly nodes: MemoryNodeStore;

  constructor(options: MemoryRepositoryV2BackendOptions) {
    this.policy = options.policy;
    this.documents = new MemoryDocumentStore({ dataDir: options.dataDir, log: options.log });
    this.resources = new MemoryResourceStore(this.documents, this.policy);
    this.nodes = new MemoryNodeStore(this.documents, this.policy);
    this.rootDir = this.documents.rootDir;
    this.indexPath = this.documents.indexPath;
  }

  initialize(): Promise<void> { return this.documents.initialize(); }
  snapshot(): Promise<MemoryTreeDocument> { return this.documents.read(); }
  getResource(id: string): Promise<MemoryResourceRegistration | undefined> { return this.resources.get(id); }
  listResources(query: MemoryResourceQuery = {}): Promise<MemoryResourceRegistration[]> { return this.resources.list(query); }
  listResourceManagementAudit(resourceId?: string, limit = 100): Promise<MemoryResourceManagementAuditRecord[]> {
    return this.resources.listAudit(resourceId, limit);
  }
  replaceResourceGroup(
    registryGroup: string,
    resources: MemoryResourceRegistration[],
    options: ReplaceMemoryResourceGroupOptions = {},
  ): Promise<MemoryResourceRegistration[]> {
    return this.resources.replaceGroup(registryGroup, resources, options);
  }
  manageResource(
    resourceId: string,
    action: Exclude<MemoryResourceManagementAction, 'rebind'>,
    options: ManageMemoryResourceOptions = {},
  ): Promise<MemoryResourceManagementResult | undefined> {
    return this.resources.manage(resourceId, action, options);
  }
  rebindResource(
    resourceId: string,
    patch: MemoryResourceRebindPatch,
    options: RebindMemoryResourceOptions = {},
  ): Promise<MemoryResourceManagementResult | undefined> {
    return this.resources.rebind(resourceId, patch, options);
  }
  removeResources(query: MemoryResourceQuery, options: RemoveMemoryResourcesOptions = {}): Promise<number> {
    return this.resources.remove(query, options);
  }
  restoreSchemaBackup(backupFile: string): Promise<void> { return this.documents.restoreSchemaBackup(backupFile); }
  getNode(id: string): Promise<MemoryNode | undefined> { return this.nodes.get(id); }
  listNodes(branch: MemoryBranchKind, scopeKey?: string): Promise<MemoryNode[]> { return this.nodes.list(branch, scopeKey); }
  rebindProjectPath(fromPath: string, toPath: string): Promise<MemoryProjectRebindResult> {
    return rebindMemoryProjectPath(this.documents, this.policy, fromPath, toPath);
  }
  children(parentNodeId: string): Promise<MemoryNode[]> { return this.nodes.children(parentNodeId); }
  write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> { return this.nodes.write(intent); }
  recordMemoryFeedback(_feedbacks: MemoryUseFeedback[]): Promise<MemoryAtom[]> { return Promise.resolve([]); }
  retryRecoveryQueue(limit = 20): Promise<MemoryWriteResult[]> { return this.nodes.retryRecoveryQueue(limit); }
  setStatus(nodeId: string, status: MemoryNode['status']): Promise<MemoryNode | undefined> {
    return this.nodes.setStatus(nodeId, status);
  }
  changeTier(nodeId: string, tier: InjectionTier): Promise<MemoryNode | undefined> {
    return this.nodes.changeTier(nodeId, tier);
  }
  manageNode(
    nodeId: string,
    action: MemoryManagementAction,
    reason = 'Changed by the user from the memory-tree management page.',
  ): Promise<MemoryManagementResult | undefined> {
    return this.nodes.manage(nodeId, action, reason);
  }
  getMigration(id: string): Promise<MemoryMigrationRecord | undefined> { return this.nodes.getMigration(id); }
  markMigration(record: MemoryMigrationRecord): Promise<void> { return this.nodes.markMigration(record); }
  async managementStatus(): Promise<MemoryRepositoryManagementStatus> {
    return {
      backendKind: 'v2',
      storageKind: 'legacy-index',
      retrievalSupported: false,
    };
  }
  async inspectNodeForManagement(
    nodeId: string,
    disclosureLevel: MemoryRepositoryNodeInspection['disclosureLevel'],
  ): Promise<MemoryRepositoryNodeInspection | undefined> {
    const node = await this.nodes.get(nodeId);
    if (!node || node.isBranchRoot) return undefined;
    return { backendKind: 'v2', nodeId, disclosureLevel };
  }
}
