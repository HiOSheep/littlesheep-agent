// Defines the stable repository port shared by the v2 and Memory v3 backends.

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
  MemoryWriteResult,
} from '../types.js';
import type {
  ManageMemoryResourceOptions,
  RebindMemoryResourceOptions,
  RemoveMemoryResourcesOptions,
  ReplaceMemoryResourceGroupOptions,
} from './contracts.js';
import type { MemoryProjectRebindResult } from './project-rebinding.js';
import type { MemoryRepositoryRetrievalBackend } from './retrieval.js';
import type {
  MemoryRepositoryManagementStatus,
  MemoryRepositoryNodeInspection,
} from './management.js';

export interface MemoryRepositoryBackend extends Partial<MemoryRepositoryRetrievalBackend> {
  readonly rootDir: string;
  readonly indexPath: string;
  initialize(): Promise<void>;
  snapshot(): Promise<MemoryTreeDocument>;
  getResource(id: string): Promise<MemoryResourceRegistration | undefined>;
  listResources(query?: MemoryResourceQuery): Promise<MemoryResourceRegistration[]>;
  listResourceManagementAudit(resourceId?: string, limit?: number): Promise<MemoryResourceManagementAuditRecord[]>;
  replaceResourceGroup(
    registryGroup: string,
    resources: MemoryResourceRegistration[],
    options?: ReplaceMemoryResourceGroupOptions,
  ): Promise<MemoryResourceRegistration[]>;
  manageResource(
    resourceId: string,
    action: Exclude<MemoryResourceManagementAction, 'rebind'>,
    options?: ManageMemoryResourceOptions,
  ): Promise<MemoryResourceManagementResult | undefined>;
  rebindResource(
    resourceId: string,
    patch: MemoryResourceRebindPatch,
    options?: RebindMemoryResourceOptions,
  ): Promise<MemoryResourceManagementResult | undefined>;
  removeResources(query: MemoryResourceQuery, options?: RemoveMemoryResourcesOptions): Promise<number>;
  restoreSchemaBackup(backupFile: string): Promise<void>;
  getNode(id: string): Promise<MemoryNode | undefined>;
  listNodes(branch: MemoryBranchKind, scopeKey?: string): Promise<MemoryNode[]>;
  rebindProjectPath(fromPath: string, toPath: string): Promise<MemoryProjectRebindResult>;
  children(parentNodeId: string): Promise<MemoryNode[]>;
  write(intent: MemoryWriteIntent): Promise<MemoryWriteResult>;
  retryRecoveryQueue(limit?: number): Promise<MemoryWriteResult[]>;
  setStatus(nodeId: string, status: MemoryNode['status']): Promise<MemoryNode | undefined>;
  changeTier(nodeId: string, tier: InjectionTier): Promise<MemoryNode | undefined>;
  manageNode(nodeId: string, action: MemoryManagementAction, reason?: string): Promise<MemoryManagementResult | undefined>;
  getMigration(id: string): Promise<MemoryMigrationRecord | undefined>;
  markMigration(record: MemoryMigrationRecord): Promise<void>;
  managementStatus(): Promise<MemoryRepositoryManagementStatus>;
  inspectNodeForManagement(
    nodeId: string,
    disclosureLevel: MemoryRepositoryNodeInspection['disclosureLevel'],
  ): Promise<MemoryRepositoryNodeInspection | undefined>;
  close?(): void;
}
