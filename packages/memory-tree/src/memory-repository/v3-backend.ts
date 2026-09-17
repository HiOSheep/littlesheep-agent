// Composes the feature-flagged Memory v3 backend behind the stable MemoryRepository facade.

import { join } from 'node:path';
import { AtomicActivationLevelTracker } from '@littlesheep/types';
import type { InjectionTier } from '../types.js';
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
  MemoryWritePolicy,
  MemoryWriteResult,
} from '../types.js';
import { MemoryAtomStore } from '../v3/atom-store.js';
import { MemoryCatalog } from '../v3/catalog.js';
import { MemoryEventJournal, MemoryOperationJournal } from '../v3/event-journal.js';
import { MemoryRawRecordStore } from '../v3/raw-record-store.js';
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
import { embeddingReuseObserved } from '../v3/embedding-reuse-tally.js';
import { MemoryV3ResourceStore } from './v3-resource-store.js';
import { MemoryV3Retrieval } from './v3-retrieval.js';
import type {
  MemoryRepositoryCandidate,
  MemoryRepositoryIndexRequest,
  MemoryRepositoryRetrievalRequest,
} from './retrieval.js';
import type { MemoryAccessRecord, MemoryAtom, MemoryUseFeedback } from '../v3/contracts.js';
import type {
  MemoryAtomManagementRequest,
  MemoryAtomManagementResult,
  MemoryRepositoryManagementStatus,
  MemoryRepositoryNodeInspection,
} from './management.js';
import { MemoryV3AtomManagement } from './v3-atom-management.js';
import { validateMemoryV3RepositoryState } from './v3-migration-validation-state.js';
import type { MemoryV3MigrationValidation } from './v3-migration-contracts.js';
import { MemoryV3FeedbackManager, MEMORY_USE_FEEDBACK_PAYLOAD_KEY } from './v3-feedback-manager.js';
import { memoryCatalogActivationScore } from '../v3/activation.js';
import { isMemoryV3InternalRootId } from './v3-node-mapping.js';
import { MAX_SUBTREE_ACTIVE_DESCENDANTS } from '../memory-subtree-contracts.js';

export interface MemoryRepositoryV3BackendOptions {
  dataDir: string;
  policy: MemoryWritePolicy;
  log?: MemoryRepositoryOptions['log'];
  v3?: MemoryRepositoryOptions['v3'];
}

export class MemoryRepositoryV3Backend implements MemoryRepositoryBackend {
  readonly dataDir: string;
  readonly rootDir: string;
  readonly indexPath: string;
  readonly atomStore: MemoryAtomStore;
  readonly catalog: MemoryCatalog;
  readonly graphStore: MemoryV3GraphStore;
  readonly rawRecordStore: MemoryRawRecordStore;
  readonly ledger: MemoryV3RepositoryLedger;
  readonly coordinator: MemoryV3StorageCoordinator;
  readonly maintenance: MemoryV3MaintenanceWorker;
  private readonly eventJournal: MemoryEventJournal;
  private readonly nodes: MemoryV3NodeStore;
  private readonly atomManagement: MemoryV3AtomManagement;
  private readonly feedback: MemoryV3FeedbackManager;
  private readonly resources: MemoryV3ResourceStore;
  private readonly retrieval: MemoryV3Retrieval;
  private readonly activationLevels = new AtomicActivationLevelTracker(100_000);
  private readonly log?: MemoryRepositoryOptions['log'];
  private closed = false;
  private backgroundMaintenanceEnabled = false;
  private backgroundMaintenanceRun?: Promise<void>;

  constructor(options: MemoryRepositoryV3BackendOptions) {
    this.dataDir = options.dataDir;
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
    this.rawRecordStore = new MemoryRawRecordStore({ dataDir: options.dataDir, log: options.log });
    this.eventJournal = new MemoryEventJournal({ dataDir: options.dataDir, log: options.log });
    const operationJournal = new MemoryOperationJournal({ dataDir: options.dataDir, log: options.log });
    this.coordinator = new MemoryV3StorageCoordinator({
      atomStore: this.atomStore,
      catalog: this.catalog,
      eventJournal: this.eventJournal,
      operationJournal,
      rawRecordStore: this.rawRecordStore,
      onCheckpoint: async (checkpoint, context) => {
        if (checkpoint !== 'catalog-updated') return;
        const record = await this.eventJournal.get(context.eventId);
        if (!record) return;
        await this.ledger.materializeEventAudits(record.event.payload);
        const feedback = record.event.payload[MEMORY_USE_FEEDBACK_PAYLOAD_KEY];
        if (feedback && typeof feedback === 'object') this.catalog.recordFeedback(feedback as MemoryUseFeedback);
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
    this.atomManagement = new MemoryV3AtomManagement({
      atomStore: this.atomStore,
      catalog: this.catalog,
      coordinator: this.coordinator,
    });
    this.feedback = new MemoryV3FeedbackManager(
      this.atomStore,
      this.catalog,
      this.coordinator,
      this.graphStore,
    );
    this.resources = new MemoryV3ResourceStore({
      dataDir: options.dataDir,
      catalog: this.catalog,
      graphStore: this.graphStore,
      ledger: this.ledger,
      policy: options.policy,
      log: options.log,
    });
    this.retrieval = new MemoryV3Retrieval({ atomStore: this.atomStore, catalog: this.catalog, graphStore: this.graphStore, ledger: this.ledger });
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
    try {
      const relationRecovery = await this.nodes.reconcileGraphProjection();
      if (relationRecovery.truncated) {
        this.log?.('warn', 'memory-v3: proposed relation recovery reached its bounded startup limit', relationRecovery);
      }
    } catch (error) {
      this.log?.('warn', `memory-v3: proposed relation recovery remains deferred: ${errorMessage(error)}`);
    }
    await this.resources.initialize();
    await this.recoverProjectTransactions();
    const maintenance = await this.maintenance.runStartupCompensation();
    if (maintenance.due.failures.length > 0 || maintenance.embeddings.failures.length > 0) {
      this.log?.('warn', 'memory-v3: startup maintenance completed with recoverable failures', maintenance);
    }
  }

  startBackgroundMaintenance(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.backgroundMaintenanceEnabled = true;
    if (this.backgroundMaintenanceRun) return this.backgroundMaintenanceRun;
    const run = this.maintenance.startBackgroundDrain()
      .then((result) => {
        if (result.stalled && result.last) {
          this.log?.('warn', 'memory-v3: background maintenance paused without making further progress', result);
        }
      })
      .catch((error) => {
        if (!isAbortError(error)) this.log?.('warn', `memory-v3: background maintenance failed: ${errorMessage(error)}`);
      })
      .finally(() => {
        if (this.backgroundMaintenanceRun === run) this.backgroundMaintenanceRun = undefined;
      });
    this.backgroundMaintenanceRun = run;
    return run;
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
      schemaMigrations: ledger.schemaMigrations,
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
  listRecentNodes(branch: MemoryBranchKind, query: MemoryRecentNodeQuery = {}): Promise<MemoryNode[]> {
    return this.nodes.listRecent(branch, query);
  }
  children(parentNodeId: string): Promise<MemoryNode[]> { return this.nodes.children(parentNodeId); }
  write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> {
    // Reset earlier noise, then attribute this intent's real embedding reuse.
    this.catalog.drainEmbeddingReuse();
    const written = this.nodes.write(intent).then((result) => {
      const embeddingReuse = this.catalog.drainEmbeddingReuse();
      return embeddingReuseObserved(embeddingReuse) ? { ...result, embeddingReuse } : result;
    });
    return this.withPostWriteMaintenance(written, (result) => Boolean(result.node));
  }
  recordMemoryFeedback(feedbacks: MemoryUseFeedback[]): Promise<MemoryAtom[]> {
    return this.withPostWriteMaintenance(this.feedback.recordMany(feedbacks), (atoms) => atoms.length > 0);
  }
  retryRecoveryQueue(limit = 20): Promise<MemoryWriteResult[]> {
    return this.withPostWriteMaintenance(
      this.nodes.retryRecoveryQueue(limit),
      (results) => results.some((result) => Boolean(result.node)),
    );
  }
  setStatus(nodeId: string, status: MemoryNode['status']): Promise<MemoryNode | undefined> {
    return this.withPostWriteMaintenance(this.nodes.setStatus(nodeId, status), Boolean);
  }
  changeTier(nodeId: string, tier: InjectionTier): Promise<MemoryNode | undefined> {
    return this.withPostWriteMaintenance(this.nodes.changeTier(nodeId, tier), Boolean);
  }
  manageNode(
    nodeId: string,
    action: MemoryManagementAction,
    reason = 'Changed by the user from the memory-tree management page.',
    expectedRevision?: number,
  ): Promise<MemoryManagementResult | undefined> {
    return this.withPostWriteMaintenance(this.nodes.manage(nodeId, action, reason, expectedRevision), Boolean);
  }
  getMigration(id: string): Promise<MemoryMigrationRecord | undefined> { return this.nodes.getMigration(id); }
  markMigration(record: MemoryMigrationRecord): Promise<void> { return this.nodes.markMigration(record); }
  indexMemory(request: MemoryRepositoryIndexRequest): Promise<MemoryRepositoryCandidate[]> { return this.retrieval.indexMemory(request); }
  retrieveMemory(request: MemoryRepositoryRetrievalRequest): Promise<MemoryRepositoryCandidate[]> { return this.retrieval.retrieveMemory(request); }
  recordMemoryAccess(records: MemoryAccessRecord[]): void { this.retrieval.recordMemoryAccess(records); }

  async managementStatus(): Promise<MemoryRepositoryManagementStatus> {
    const now = new Date().toISOString();
    const activationEntries: Array<{ id: string; score: number }> = [];
    for (const entry of this.catalog.listAtoms({ status: 'active', limit: 100_000, orderBy: 'activation' })) {
      if (isMemoryV3InternalRootId(entry.atomId)) continue;
      activationEntries.push({ id: entry.atomId, score: memoryCatalogActivationScore(entry, now) });
    }
    const activation = this.activationLevels.project(activationEntries);
    return {
      backendKind: 'v3',
      storageKind: 'atom-catalog',
      retrievalSupported: true,
      catalog: {
        integrity: this.catalog.integrityCheck(),
        atomCount: this.catalog.countAtoms(),
        embedding: this.catalog.embeddingStatusCounts(),
        activation,
      },
    };
  }

  async inspectNodeForManagement(
    nodeId: string,
    disclosureLevel: MemoryRepositoryNodeInspection['disclosureLevel'],
  ): Promise<MemoryRepositoryNodeInspection | undefined> {
    const atom = await this.atomStore.read(nodeId);
    if (!atom) return undefined;
    const now = new Date().toISOString();
    const [retrieved] = await this.retrieval.retrieveMemory({
      branch: atom.branch,
      scopes: [{ scope: atom.scope, scopeKey: this.ledger.publicScopeKey(atom.scope, atom.scopeKey) }],
      query: '',
      limit: 1,
      now,
      nodeId,
      disclosureLevel,
      mode: 'expand',
    });
    const candidate = retrieved ?? await this.retrieval.inspectAtomForManagement(atom, disclosureLevel, now);
    return {
      backendKind: 'v3',
      nodeId,
      disclosureLevel,
      atom: candidate.atom,
      catalog: this.catalog.getAtom(nodeId),
      envelope: candidate.envelope,
      neighborhood: candidate.neighborhood,
      history: candidate.history,
      projectionRecords: disclosureLevel === 'D3'
        ? await this.rawRecordStore.listForAtom(nodeId, 100)
        : undefined,
      hasActiveChildren: this.catalog.hasActiveChildren(nodeId),
      activeDescendantCount: this.catalog.countActiveDescendants(
        nodeId,
        MAX_SUBTREE_ACTIVE_DESCENDANTS + 1,
      ),
    };
  }

  manageAtomForManagement(request: MemoryAtomManagementRequest): Promise<MemoryAtomManagementResult> {
    return this.withPostWriteMaintenance(this.atomManagement.manage(request), () => true);
  }

  validateMigrationSourceForManagement(
    source: MemoryTreeDocument,
    sourceManifestHash: string,
  ): Promise<MemoryV3MigrationValidation> {
    return validateMemoryV3RepositoryState(this, source, sourceManifestHash);
  }

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
    this.maintenance.stop();
    this.activationLevels.clear();
    this.catalog.close();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.maintenance.shutdown();
    this.activationLevels.clear();
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

  private async withPostWriteMaintenance<T>(
    operation: Promise<T>,
    changed: (result: T) => boolean,
  ): Promise<T> {
    const result = await operation;
    if (!changed(result) || this.closed) return result;
    try {
      const maintenance = await this.maintenance.runAfterWrite();
      if (maintenance.due.failures.length > 0 || maintenance.embeddings.failures.length > 0
        || maintenance.embeddings.unavailable) {
        this.log?.('warn', 'memory-v3: post-write maintenance completed with recoverable failures', maintenance);
      }
      if (this.backgroundMaintenanceEnabled
        && maintenance.due.remaining + maintenance.embeddings.remaining > 0
        && !maintenance.embeddings.unavailable) {
        void this.startBackgroundMaintenance();
      }
    } catch (error) {
      this.log?.('warn', `memory-v3: post-write maintenance failed without rolling back the committed atom: ${errorMessage(error)}`);
    }
    return result;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
