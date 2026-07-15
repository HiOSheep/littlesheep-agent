// Composes the feature-flagged Memory v3 backend behind the stable MemoryRepository facade.

import { join } from 'node:path';
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
import { MemoryAtomStore } from '../v3/atom-store.js';
import { MemoryCatalog } from '../v3/catalog.js';
import { MemoryEventJournal, MemoryOperationJournal } from '../v3/event-journal.js';
import { MemoryV3GraphStore } from '../v3/graph-store.js';
import { MemoryV3MaintenanceWorker } from '../v3/maintenance-worker.js';
import { MemoryV3StorageCoordinator } from '../v3/storage-coordinator.js';
import type { MemoryRepositoryBackend } from './backend.js';
import type {
  ManageMemoryResourceOptions,
  MemoryRepositoryOptions,
  RebindMemoryResourceOptions,
  RemoveMemoryResourcesOptions,
  ReplaceMemoryResourceGroupOptions,
} from './contracts.js';
import { CURRENT_MEMORY_DOCUMENT_VERSION, MEMORY_RESOURCE_REGISTRY_VERSION } from './document-store.js';
import { normalizedFilePath, sameFilePath } from './path-utils.js';
import type { MemoryProjectRebindResult } from './project-rebinding.js';
import { MemoryV3RepositoryLedger, type MemoryV3RepositoryTransaction } from './v3-ledger.js';
import { MemoryV3NodeStore } from './v3-node-store.js';
import { MemoryV3ResourceStore } from './v3-resource-store.js';

export interface MemoryRepositoryV3BackendOptions {
  dataDir: string;
  policy: MemoryWritePolicy;
  log?: MemoryRepositoryOptions['log'];
  v3?: MemoryRepositoryOptions['v3'];
}

export class MemoryRepositoryV3Backend implements MemoryRepositoryBackend {
  readonly rootDir: string;
  readonly indexPath: string;
  readonly atomStore: MemoryAtomStore;
  readonly catalog: MemoryCatalog;
  readonly graphStore: MemoryV3GraphStore;
  readonly ledger: MemoryV3RepositoryLedger;
  readonly coordinator: MemoryV3StorageCoordinator;
  readonly maintenance: MemoryV3MaintenanceWorker;
  private readonly eventJournal: MemoryEventJournal;
  private readonly nodes: MemoryV3NodeStore;
  private readonly resources: MemoryV3ResourceStore;
  private readonly log?: MemoryRepositoryOptions['log'];
  private closed = false;

  constructor(options: MemoryRepositoryV3BackendOptions) {
    this.rootDir = join(options.dataDir, 'memory-tree', 'v3');
    this.indexPath = join(this.rootDir, 'catalog.sqlite');
    this.log = options.log;
    this.ledger = new MemoryV3RepositoryLedger({
      dataDir: options.dataDir,
      maxAuditRecords: options.policy.maxAuditRecords,
      log: options.log,
    });
    this.atomStore = new MemoryAtomStore({ dataDir: options.dataDir, log: options.log });
    this.catalog = new MemoryCatalog({
      dataDir: options.dataDir,
      embeddingEngine: options.v3?.embeddingEngine,
      allowRemoteEmbedding: options.v3?.allowRemoteEmbedding,
      maxAuditRecords: options.policy.maxAuditRecords,
    });
    this.graphStore = new MemoryV3GraphStore({ dataDir: options.dataDir, catalog: this.catalog, log: options.log });
    this.eventJournal = new MemoryEventJournal({ dataDir: options.dataDir, log: options.log });
    const operationJournal = new MemoryOperationJournal({ dataDir: options.dataDir, log: options.log });
    this.coordinator = new MemoryV3StorageCoordinator({
      atomStore: this.atomStore,
      catalog: this.catalog,
      eventJournal: this.eventJournal,
      operationJournal,
      onCheckpoint: async (checkpoint, context) => {
        if (checkpoint !== 'catalog-updated') return;
        const record = await this.eventJournal.get(context.eventId);
        if (record) await this.ledger.materializeEventAudits(record.event.payload);
      },
    });
    this.nodes = new MemoryV3NodeStore({
      atomStore: this.atomStore,
      catalog: this.catalog,
      coordinator: this.coordinator,
      graphStore: this.graphStore,
      ledger: this.ledger,
      policy: options.policy,
      log: options.log,
    });
    this.resources = new MemoryV3ResourceStore({
      dataDir: options.dataDir,
      catalog: this.catalog,
      graphStore: this.graphStore,
      ledger: this.ledger,
      policy: options.policy,
      log: options.log,
    });
    this.maintenance = new MemoryV3MaintenanceWorker({
      atomStore: this.atomStore,
      catalog: this.catalog,
      eventJournal: this.eventJournal,
      embeddingBatchSize: options.v3?.maxEmbeddingBatchSize,
      dueBatchSize: options.v3?.maxDueBatchSize,
    });
  }

  async initialize(): Promise<void> {
    await this.ledger.initialize();
    await this.graphStore.initialize();
    const recovery = await this.coordinator.initialize();
    for (const eventId of recovery.recoveredEventIds) {
      const record = await this.eventJournal.get(eventId);
      if (record) await this.ledger.materializeEventAudits(record.event.payload);
    }
    await this.nodes.initialize();
    await this.resources.initialize();
    await this.recoverProjectTransactions();
    const maintenance = await this.maintenance.runStartupCompensation();
    if (maintenance.due.failures.length > 0 || maintenance.embeddings.failures.length > 0) {
      this.log?.('warn', 'memory-v3: startup maintenance completed with recoverable failures', maintenance);
    }
  }

  async snapshot(): Promise<MemoryTreeDocument> {
    const [nodes, resources, ledger] = await Promise.all([
      this.nodes.snapshotNodes(),
      this.resources.snapshotResources(),
      this.ledger.snapshot(),
    ]);
    const updatedAt = [
      ...Object.values(nodes).map((node) => node.updatedAt),
      ...Object.values(resources).map((resource) => resource.updatedAt),
      ...ledger.writeAudit.map((record) => record.at),
      ...ledger.managementAudit.map((record) => record.at),
      ...ledger.resourceManagementAudit.map((record) => record.at),
    ].sort().at(-1) ?? new Date().toISOString();
    return {
      version: CURRENT_MEMORY_DOCUMENT_VERSION,
      registryVersion: MEMORY_RESOURCE_REGISTRY_VERSION,
      updatedAt,
      nodes,
      resources,
      recoveryQueue: ledger.recoveryQueue,
      writeAudit: ledger.writeAudit,
      managementAudit: ledger.managementAudit,
      resourceManagementAudit: ledger.resourceManagementAudit,
      migrations: ledger.migrations,
      schemaMigrations: [],
    };
  }

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
  restoreSchemaBackup(_backupFile: string): Promise<void> {
    return Promise.reject(new Error('Memory v3 does not use a monolithic schema backup; use the phase 4 migration rollback API.'));
  }
  getNode(id: string): Promise<MemoryNode | undefined> { return this.nodes.get(id); }
  listNodes(branch: MemoryBranchKind, scopeKey?: string): Promise<MemoryNode[]> { return this.nodes.list(branch, scopeKey); }
  children(parentNodeId: string): Promise<MemoryNode[]> { return this.nodes.children(parentNodeId); }
  write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> { return this.nodes.write(intent); }
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

  async rebindProjectPath(fromPath: string, toPath: string): Promise<MemoryProjectRebindResult> {
    const from = normalizedFilePath(fromPath);
    const to = normalizedFilePath(toPath);
    const empty = { nodeCount: 0, recoveryIntentCount: 0, resourceCount: 0 };
    if (sameFilePath(from, to)) return empty;
    const transaction = await this.ledger.captureTransaction(
      `project-rebind:${from.toLocaleLowerCase()}:${to.toLocaleLowerCase()}`,
      'project-rebind',
      { fromPath: from, toPath: to },
    );
    try {
      const result = await this.applyProjectRebind(transaction);
      await this.ledger.commitTransaction(transaction.id);
      return result;
    } catch (error) {
      await this.ledger.markTransactionRecovery(transaction.id, errorMessage(error));
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.catalog.close();
  }

  private async recoverProjectTransactions(): Promise<void> {
    for (const transaction of await this.ledger.listOutstandingTransactions()) {
      if (transaction.kind !== 'project-rebind') continue;
      try {
        await this.applyProjectRebind(transaction);
        await this.ledger.commitTransaction(transaction.id);
      } catch (error) {
        await this.ledger.markTransactionRecovery(transaction.id, errorMessage(error));
        this.log?.('warn', `memory-v3: project rebind ${transaction.id} remains in recovery: ${errorMessage(error)}`);
      }
    }
  }

  private async applyProjectRebind(transaction: MemoryV3RepositoryTransaction): Promise<MemoryProjectRebindResult> {
    const fromPath = String(transaction.payload.fromPath ?? '');
    const toPath = String(transaction.payload.toPath ?? '');
    if (!fromPath || !toPath) throw new Error('Memory v3 project rebind transaction is missing paths.');
    const result: MemoryProjectRebindResult = {
      nodeCount: await this.nodes.countPublicScope(fromPath),
      recoveryIntentCount: 0,
      resourceCount: 0,
    };
    if (!transaction.completedSteps.includes('scope-alias')) {
      await this.ledger.rebindScope(fromPath, toPath);
      transaction = await this.ledger.markTransactionStep(transaction.id, 'scope-alias');
    } else {
      result.nodeCount = 0;
    }
    if (!transaction.completedSteps.includes('recovery-intents')) {
      result.recoveryIntentCount = await this.ledger.rebindQueuedIntents(fromPath, toPath);
      transaction = await this.ledger.markTransactionStep(transaction.id, 'recovery-intents');
    }
    if (!transaction.completedSteps.includes('resources')) {
      result.resourceCount = await this.resources.rebindProjectPath(fromPath, toPath);
      await this.ledger.markTransactionStep(transaction.id, 'resources');
    }
    return result;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
