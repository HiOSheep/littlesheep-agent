// Owns the MemoryRepository node contract on top of Memory v3 atoms, catalog, and journals.

import { randomUUID } from 'node:crypto';
import { InjectionTier } from '../types.js';
import type {
  LogFn,
  MemoryBranchKind,
  MemoryManagementAction,
  MemoryManagementAuditRecord,
  MemoryManagementResult,
  MemoryMigrationRecord,
  MemoryNode,
  MemoryRecentNodeQuery,
  MemoryScope,
  MemoryWriteIntent,
  MemoryWritePolicy,
  MemoryWriteResult,
} from '../types.js';
import { MemoryAtomStore } from '../v3/atom-store.js';
import { MemoryCatalog } from '../v3/catalog.js';
import { MemoryV3GraphStore } from '../v3/graph-store.js';
import type {
  MemoryAtom,
  MemoryAtomPatch,
  MemoryCatalogEntry,
  MemoryUpdateEvent,
} from '../v3/contracts.js';
import { MEMORY_EVENT_VERSION } from '../v3/contracts.js';
import { MemoryV3StorageCoordinator } from '../v3/storage-coordinator.js';
import { MEMORY_BRANCH_ROOTS, memoryBranchRootId } from './document-store.js';
import {
  equivalentMemoryNode,
  assertMemoryTierChange,
  memoryIntentRejectionReason,
  memoryNodeSimilarity,
  normalizeMemoryIntent,
} from './write-policy.js';
import { cleanText, unique } from './text.js';
import { classifyMemoryWriteIntent, sameStatementCategory, type ClassifiedMemoryStatement } from './v3-statement.js';
import { MemoryV3RepositoryLedger } from './v3-ledger.js';
import {
  createMemoryAtomInput,
  createMemoryV3ScopeRoot,
  isMemoryV3InternalRootId,
  memoryAtomToNode,
  memoryV3ScopeRootId,
} from './v3-node-mapping.js';
import {
  MemoryV3WriteGraphProjection,
  type MemoryV3RelationProjectionRecovery,
} from './v3-write-graph-projection.js';
import {
  atomIdForIntent,
  branchForRootId,
  intentEvent,
  managementMutation,
  repositoryEvent,
  statusMutation,
  strongerEpistemicStatus,
  strongerResolutionStatus,
  writeAudit,
} from './v3-node-transitions.js';

export interface MemoryV3NodeStoreOptions {
  atomStore: MemoryAtomStore;
  catalog: MemoryCatalog;
  coordinator: MemoryV3StorageCoordinator;
  graphStore: MemoryV3GraphStore;
  ledger: MemoryV3RepositoryLedger;
  policy: MemoryWritePolicy;
  log?: LogFn;
}

export class MemoryV3NodeStore {
  private readonly atomStore: MemoryAtomStore;
  private readonly catalog: MemoryCatalog;
  private readonly coordinator: MemoryV3StorageCoordinator;
  private readonly graphProjection: MemoryV3WriteGraphProjection;
  private readonly ledger: MemoryV3RepositoryLedger;
  private readonly policy: MemoryWritePolicy;
  private readonly log?: LogFn;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryV3NodeStoreOptions) {
    this.atomStore = options.atomStore;
    this.catalog = options.catalog;
    this.coordinator = options.coordinator;
    this.graphProjection = new MemoryV3WriteGraphProjection(options.graphStore, options.catalog);
    this.ledger = options.ledger;
    this.policy = options.policy;
    this.log = options.log;
  }

  async initialize(): Promise<void> {
    for (const branch of Object.keys(MEMORY_BRANCH_ROOTS) as MemoryBranchKind[]) {
      await this.ensureScopeRoot(branch, 'global', undefined);
    }
  }

  reconcileGraphProjection(limit?: number): Promise<MemoryV3RelationProjectionRecovery> {
    return this.exclusive(() => this.graphProjection.reconcile(limit));
  }

  async get(id: string): Promise<MemoryNode | undefined> {
    const branch = branchForRootId(id);
    if (branch) return this.virtualRoot(branch);
    const atom = await this.atomStore.read(id);
    return atom && !isMemoryV3InternalRootId(atom.id) ? this.toNode(atom) : undefined;
  }

  async list(branch: MemoryBranchKind, scopeKey?: string): Promise<MemoryNode[]> {
    const entries = this.catalog.listAtoms({ branch, status: 'active', limit: 100_000 })
      .filter((entry) => !isMemoryV3InternalRootId(entry.atomId));
    const nodes = await this.readNodes(entries);
    return nodes
      .filter((node) => !scopeKey || !node.scopeKey || node.scopeKey === scopeKey)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listRecent(branch: MemoryBranchKind, query: MemoryRecentNodeQuery = {}): Promise<MemoryNode[]> {
    const limit = boundedRecentNodeLimit(query.limit);
    const storageScopeKey = query.scope && query.scopeKey
      ? await this.ledger.storageScopeKey(query.scope, query.scopeKey)
      : undefined;
    const entries = this.catalog.listAtoms({
      branch,
      scope: query.scope,
      scopeKey: storageScopeKey,
      status: query.status === 'deleted' ? 'tombstone' : query.status ?? 'active',
      limit,
    }).filter((entry) => !isMemoryV3InternalRootId(entry.atomId));
    return this.readNodes(entries);
  }

  async children(parentNodeId: string): Promise<MemoryNode[]> {
    const branch = branchForRootId(parentNodeId);
    if (branch) {
      const entries = this.catalog.listAtoms({ branch, status: 'active', limit: 100_000 })
        .filter((entry) => entry.parentId && isMemoryV3InternalRootId(entry.parentId));
      return this.readNodes(entries);
    }
    return this.readNodes(this.catalog.listChildrenByParent(parentNodeId));
  }

  write(intent: MemoryWriteIntent): Promise<MemoryWriteResult> {
    return this.exclusive(() => this.writeInternal(intent, true));
  }

  retryRecoveryQueue(limit = 20): Promise<MemoryWriteResult[]> {
    return this.exclusive(async () => {
      const results: MemoryWriteResult[] = [];
      for (const queued of await this.ledger.listRecovery(limit)) {
        if (queued.attempts >= 3) continue;
        const result = await this.writeInternal(queued.intent, false);
        if (result.decision === 'queued') {
          await this.ledger.updateRecovery({ ...queued, attempts: queued.attempts + 1, error: result.reason });
        } else {
          await this.ledger.removeRecovery(queued.id);
        }
        results.push(result);
      }
      return results;
    });
  }

  setStatus(nodeId: string, status: MemoryNode['status']): Promise<MemoryNode | undefined> {
    return this.exclusive(async () => {
      const atom = await this.mutableAtom(nodeId);
      if (!atom) return undefined;
      const mutation = statusMutation(atom, status);
      const updated = await this.coordinator.apply(
        repositoryEvent(atom, `status:${status}`, 'configuration-change', undefined),
        mutation,
      );
      return this.toNode(updated);
    });
  }

  changeTier(nodeId: string, tier: InjectionTier): Promise<MemoryNode | undefined> {
    return this.exclusive(async () => {
      const atom = await this.mutableAtom(nodeId);
      if (!atom) return undefined;
      assertMemoryTierChange(atom.branch, tier);
      const updated = await this.coordinator.apply(
        repositoryEvent(atom, `tier:${tier}`, 'configuration-change', undefined),
        { kind: 'update', atomId: atom.id, expectedRevision: atom.revision, patch: { tier } },
      );
      return this.toNode(updated);
    });
  }

  manage(
    nodeId: string,
    action: MemoryManagementAction,
    reason = 'Changed by the user from the memory-tree management page.',
    expectedRevision?: number,
  ): Promise<MemoryManagementResult | undefined> {
    return this.exclusive(async () => {
      const atom = await this.mutableAtom(nodeId);
      if (!atom) return undefined;
      if (expectedRevision !== undefined && atom.revision !== expectedRevision) {
        throw new Error(`Memory atom ${atom.id} revision conflict: expected ${expectedRevision}, found ${atom.revision}.`);
      }
      const children = await this.children(atom.id);
      if ((action === 'archive' || action === 'delete') && children.some((child) => child.status !== 'deleted')) {
        throw new Error('Manage child memories before changing this parent memory.');
      }
      if (action === 'restore') {
        const parent = atom.parentId ? await this.atomStore.read(atom.parentId) : undefined;
        if (!parent || parent.status !== 'active') throw new Error('Restore the parent memory before restoring this item.');
      }
      const fromStatus = atom.status === 'tombstone' ? 'deleted' : atom.status;
      const fromTier = atom.tier;
      const { mutation, toStatus, toTier } = managementMutation(atom, action);
      const now = new Date().toISOString();
      const audit: MemoryManagementAuditRecord = {
        id: randomUUID(),
        nodeId: atom.id,
        branch: atom.branch,
        action,
        at: now,
        reason: cleanText(reason).slice(0, 500) || 'Memory-tree management action.',
        fromStatus,
        toStatus,
        fromTier,
        toTier,
      };
      const updated = await this.coordinator.apply(
        repositoryEvent(atom, `manage:${action}:${audit.id}`, 'permission-decision', {
          repositoryManagementAudit: audit,
        }),
        mutation,
      );
      return { node: await this.toNode(updated), audit };
    });
  }

  getMigration(id: string): Promise<MemoryMigrationRecord | undefined> {
    return this.ledger.getMigration(id);
  }

  markMigration(record: MemoryMigrationRecord): Promise<void> {
    return this.ledger.markMigration(record);
  }

  async snapshotNodes(): Promise<Record<string, MemoryNode>> {
    const entries = this.catalog.listAtoms({ limit: 100_000 });
    const atoms = await this.readAtoms(entries.filter((entry) => !isMemoryV3InternalRootId(entry.atomId)));
    const nodes = Object.fromEntries((await Promise.all(atoms.map((atom) => this.toNode(atom))))
      .map((node) => [node.id, node]));
    for (const branch of Object.keys(MEMORY_BRANCH_ROOTS) as MemoryBranchKind[]) {
      const root = await this.virtualRoot(branch);
      nodes[root.id] = root;
    }
    return nodes;
  }

  async countPublicScope(fromKey: string): Promise<number> {
    const entries = this.catalog.listAtoms({ limit: 100_000 })
      .filter((entry) => !isMemoryV3InternalRootId(entry.atomId) && entry.scopeKey);
    return entries.filter((entry) => this.ledger.publicScopeKey(entry.scope, entry.scopeKey) === fromKey).length;
  }

  private async writeInternal(intentValue: MemoryWriteIntent, queueOnMissing: boolean): Promise<MemoryWriteResult> {
    const intent = normalizeMemoryIntent(intentValue);
    const rejection = memoryIntentRejectionReason(intent, this.policy);
    if (rejection) {
      const audit = writeAudit(intent, 'rejected', rejection);
      await this.ledger.appendWriteAudit(audit);
      return { intentId: intent.id!, decision: 'rejected', reason: rejection };
    }

    const classification = classifyMemoryWriteIntent(intent);
    const storageScopeKey = await this.ledger.storageScopeKey(intent.scope, intent.scopeKey);
    if (intent.sourceStage === 'maintenance') {
      const revocation = await this.revocationBarrier(intent, storageScopeKey);
      if (revocation) {
        await this.ledger.appendWriteAudit(writeAudit(intent, 'rejected', revocation));
        return { intentId: intent.id!, decision: 'rejected', reason: revocation };
      }
    }
    const parent = await this.resolveParent(intent, storageScopeKey);
    if (!parent) {
      const reason = `Parent node "${intent.parentNodeId}" is unavailable in branch "${intent.branch}".`;
      const queued = queueOnMissing ? await this.ledger.enqueue(intent, reason) : undefined;
      await this.ledger.appendWriteAudit(writeAudit(intent, 'queued', reason));
      return { intentId: intent.id!, decision: 'queued', reason, queuedId: queued?.id };
    }

    const graph = await this.graphProjection.prepare(intent, classification, storageScopeKey);
    const candidates = await this.candidateAtoms(intent.branch, intent.scope, storageScopeKey, classification);
    const exact = candidates.find((atom) => equivalentMemoryNode(
      memoryAtomToNode(atom, [], this.ledger.publicScopeKey(atom.scope, atom.scopeKey)),
      intent,
    ));
    if (exact) return this.reinforce(exact, parent.id, intent, classification, graph.entityRefs, graph.relationRefs);

    const similar = candidates
      .map((atom) => ({
        atom,
        score: memoryNodeSimilarity(
          memoryAtomToNode(atom, [], this.ledger.publicScopeKey(atom.scope, atom.scopeKey)),
          intent,
        ),
      }))
      .sort((left, right) => right.score - left.score)[0];
    if (similar && similar.score >= this.policy.duplicateSimilarityThreshold) {
      return this.merge(similar.atom, similar.score, intent, classification, graph.entityRefs, graph.relationRefs);
    }

    const audit = writeAudit(intent, 'created', 'Created an indexed Memory v3 atom and refreshed its scope index.', atomIdForIntent(intent.id!));
    const atomInput = createMemoryAtomInput({
      id: audit.nodeId!,
      parentId: parent.id,
      branch: intent.branch,
      scope: intent.scope,
      storageScopeKey,
      tier: intent.tier,
      summary: intent.summary,
      content: intent.content,
      retrievalKeys: intent.retrievalKeys,
      importance: intent.importance,
      confidence: intent.confidence,
      reason: intent.reason,
      sourceRunId: intent.sourceRunId,
      sourceRunIds: intent.sourceRunIds,
      sourceStage: intent.sourceStage,
      sourceStages: intent.sourceStages,
      sourceRefs: intent.sourceRefs ?? [],
      entityRefs: graph.entityRefs,
      relationRefs: graph.relationRefs,
      classification,
      createdAt: intent.createdAt!,
    });
    const atom = await this.coordinator.apply(
      intentEvent(intent, classification, storageScopeKey, 'created', audit, atomInput.id),
      { kind: 'create', atom: atomInput },
    );
    await this.activateGraphProjection(atom);
    return { intentId: intent.id!, decision: 'created', reason: 'Indexed memory created.', node: await this.toNode(atom) };
  }

  private async reinforce(
    atom: MemoryAtom,
    requestedParentId: string,
    intent: MemoryWriteIntent,
    classification: ClassifiedMemoryStatement,
    entityRefs: string[],
    relationRefs: string[],
  ): Promise<MemoryWriteResult> {
    const sourceRefs = unique([...atom.sourceRefs, ...(intent.sourceRefs ?? [])]).slice(-256);
    const evidenceRefs = unique([...atom.evidenceRefs, ...classification.evidenceRefs]).slice(-256);
    const hasNewSource = sourceRefs.some((value) => !atom.sourceRefs.includes(value));
    const hasNewEvidence = evidenceRefs.some((value) => !atom.evidenceRefs.includes(value));
    const mayStrengthenConfidence = confidenceSupport(classification, hasNewSource, hasNewEvidence);
    const mayStrengthenPriority = hasNewSource || hasNewEvidence;
    const mayReparent = requestedParentId !== atom.parentId
      && (hasNewEvidence || classification.assertedBy.kind === 'user');
    const patch: MemoryAtomPatch = {
      parentId: mayReparent ? requestedParentId : atom.parentId,
      confidence: mayStrengthenConfidence ? Math.max(atom.confidence, intent.confidence) : atom.confidence,
      importance: mayStrengthenPriority ? Math.max(atom.importance, intent.importance) : atom.importance,
      basePriority: mayStrengthenPriority
        ? Math.max(atom.basePriority, mayStrengthenConfidence ? intent.confidence : 0, intent.importance)
        : atom.basePriority,
      retrievalKeys: unique([...atom.retrievalKeys, ...intent.retrievalKeys]),
      sourceRunIds: unique([...atom.sourceRunIds, ...(intent.sourceRunIds ?? []), intent.sourceRunId]).slice(-256),
      sourceStages: unique([...atom.sourceStages, ...(intent.sourceStages ?? []), intent.sourceStage]),
      sourceRefs,
      evidenceRefs,
      entityRefs: unique([...atom.entityRefs, ...entityRefs]),
      relationRefs: unique([...atom.relationRefs, ...relationRefs]),
      reason: intent.reason || atom.reason,
      epistemicStatus: mayStrengthenConfidence
        ? strongerEpistemicStatus(atom.epistemicStatus, classification.epistemicStatus)
        : atom.epistemicStatus,
      resolutionStatus: mayStrengthenConfidence
        ? strongerResolutionStatus(atom.resolutionStatus, classification.resolutionStatus)
        : atom.resolutionStatus,
    };
    const audit = writeAudit(
      intent,
      'reinforced',
      mayReparent
        ? 'An equivalent Memory v3 atom exists; sources were consolidated and its hierarchy was updated by a supported write.'
        : 'An equivalent Memory v3 atom exists; provenance and evidence were reinforced.',
      atom.id,
    );
    const updated = await this.coordinator.apply(
      intentEvent(intent, classification, atom.scopeKey, 'reinforced', audit, atom.id, atom.revision),
      { kind: 'update', atomId: atom.id, expectedRevision: atom.revision, patch },
    );
    await this.activateGraphProjection(updated);
    return {
      intentId: intent.id!,
      decision: 'reinforced',
      reason: 'Equivalent indexed memory reinforced.',
      node: await this.toNode(updated),
    };
  }

  private async merge(
    atom: MemoryAtom,
    score: number,
    intent: MemoryWriteIntent,
    classification: ClassifiedMemoryStatement,
    entityRefs: string[],
    relationRefs: string[],
  ): Promise<MemoryWriteResult> {
    const sourceRefs = unique([...atom.sourceRefs, ...(intent.sourceRefs ?? [])]).slice(-256);
    const evidenceRefs = unique([...atom.evidenceRefs, ...classification.evidenceRefs]).slice(-256);
    const hasNewSource = sourceRefs.some((value) => !atom.sourceRefs.includes(value));
    const hasNewEvidence = evidenceRefs.some((value) => !atom.evidenceRefs.includes(value));
    const mayStrengthenConfidence = confidenceSupport(classification, hasNewSource, hasNewEvidence);
    const mayStrengthenPriority = hasNewSource || hasNewEvidence;
    const patch: MemoryAtomPatch = {
      confidence: mayStrengthenConfidence ? Math.max(atom.confidence, intent.confidence) : atom.confidence,
      importance: mayStrengthenPriority ? Math.max(atom.importance, intent.importance) : atom.importance,
      basePriority: mayStrengthenPriority
        ? Math.max(atom.basePriority, mayStrengthenConfidence ? intent.confidence : 0, intent.importance)
        : atom.basePriority,
      retrievalKeys: unique([...atom.retrievalKeys, ...intent.retrievalKeys]),
      sourceRunIds: unique([...atom.sourceRunIds, ...(intent.sourceRunIds ?? []), intent.sourceRunId]).slice(-256),
      sourceStages: unique([...atom.sourceStages, ...(intent.sourceStages ?? []), intent.sourceStage]),
      sourceRefs,
      evidenceRefs,
      mergedIntentIds: unique([...(atom.mergedIntentIds ?? []), intent.id!]).slice(-256),
      entityRefs: unique([...atom.entityRefs, ...entityRefs]),
      relationRefs: unique([...atom.relationRefs, ...relationRefs]),
      epistemicStatus: mayStrengthenConfidence
        ? strongerEpistemicStatus(atom.epistemicStatus, classification.epistemicStatus)
        : atom.epistemicStatus,
      resolutionStatus: mayStrengthenConfidence
        ? strongerResolutionStatus(atom.resolutionStatus, classification.resolutionStatus)
        : atom.resolutionStatus,
    };
    const reason = `Merged with Memory v3 atom ${atom.id} (similarity ${score.toFixed(2)}).`;
    const audit = writeAudit(intent, 'merged', reason, atom.id);
    const updated = await this.coordinator.apply(
      intentEvent(intent, classification, atom.scopeKey, 'merged', audit, atom.id, atom.revision),
      { kind: 'update', atomId: atom.id, expectedRevision: atom.revision, patch },
    );
    await this.activateGraphProjection(updated);
    return { intentId: intent.id!, decision: 'merged', reason, node: await this.toNode(updated) };
  }

  private async resolveParent(intent: MemoryWriteIntent, storageScopeKey: string | undefined): Promise<MemoryAtom | undefined> {
    if (intent.parentNodeId === memoryBranchRootId(intent.branch)) {
      return this.ensureScopeRoot(intent.branch, intent.scope, storageScopeKey);
    }
    const parent = await this.atomStore.read(intent.parentNodeId);
    if (!parent || parent.status !== 'active' || parent.branch !== intent.branch || parent.scope !== intent.scope
      || (parent.scopeKey ?? '') !== (storageScopeKey ?? '')) return undefined;
    return parent;
  }

  private async ensureScopeRoot(
    branch: MemoryBranchKind,
    scope: MemoryScope,
    storageScopeKey: string | undefined,
  ): Promise<MemoryAtom> {
    const id = memoryV3ScopeRootId(branch, scope, storageScopeKey);
    const existing = await this.atomStore.read(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const input = createMemoryV3ScopeRoot(branch, scope, storageScopeKey, now);
    const event: MemoryUpdateEvent = {
      version: MEMORY_EVENT_VERSION,
      id: randomUUID(),
      idempotencyKey: `memory-v3-scope-root:${id}`,
      kind: 'configuration-change',
      domain: input.domain,
      scope,
      scopeKey: storageScopeKey,
      atomId: id,
      source: input.assertedBy,
      occurredAt: now,
      observedAt: now,
      sourceRefs: [],
      evidenceRefs: input.evidenceRefs,
      payload: { internal: true, purpose: 'scope-root' },
    };
    return this.coordinator.apply(event, { kind: 'create', atom: input });
  }

  private async candidateAtoms(
    branch: MemoryBranchKind,
    scope: MemoryScope,
    storageScopeKey: string | undefined,
    classification: ClassifiedMemoryStatement,
  ): Promise<MemoryAtom[]> {
    const entries = this.catalog.listAtoms({ branch, scope, scopeKey: storageScopeKey, status: 'active', limit: 100_000 })
      .filter((entry) => !isMemoryV3InternalRootId(entry.atomId));
    const atoms = await this.readAtoms(entries);
    return atoms.filter((atom) => sameStatementCategory(atom, classification));
  }

  /**
   * A forgotten (tombstoned) or corrected (superseded) memory keeps its immutable
   * source provenance. Later maintenance evidence that cites the same source must
   * not recreate the revoked fact under a new atom id.
   */
  private async revocationBarrier(
    intent: MemoryWriteIntent,
    storageScopeKey: string | undefined,
  ): Promise<string | undefined> {
    const intentRefs = new Set(intent.sourceRefs ?? []);
    if (intentRefs.size === 0) return undefined;
    const entries = this.catalog.listAtoms({
      branch: intent.branch,
      scope: intent.scope,
      scopeKey: storageScopeKey,
      limit: 100_000,
    }).filter((entry) => !isMemoryV3InternalRootId(entry.atomId));
    const atoms = await this.readAtoms(entries);
    for (const atom of atoms) {
      const marker = atom.status === 'tombstone'
        ? 'tombstoned'
        : atom.epistemicStatus === 'superseded' || atom.resolutionStatus === 'superseded'
          ? 'superseded'
          : undefined;
      if (!marker) continue;
      if (atom.sourceRefs.some((ref) => intentRefs.has(ref))) {
        return `Memory write rejected: its evidence overlaps ${marker} memory ${atom.id}.`;
      }
    }
    return undefined;
  }

  private async activateGraphProjection(atom: MemoryAtom): Promise<void> {
    try {
      await this.graphProjection.activateForAtom(atom);
    } catch (error) {
      this.log?.('warn', `memory-v3: relation activation deferred to startup recovery: ${(error as Error).message}`);
    }
  }

  private async virtualRoot(branch: MemoryBranchKind): Promise<MemoryNode> {
    const rootEntries = this.catalog.listAtoms({ branch, limit: 100_000 })
      .filter((entry) => isMemoryV3InternalRootId(entry.atomId));
    const topLevel = this.catalog.listAtoms({ branch, limit: 100_000 })
      .filter((entry) => entry.parentId && isMemoryV3InternalRootId(entry.parentId));
    const active = topLevel.filter((entry) => entry.status === 'active');
    const recentAtoms = await this.readAtoms(active.slice(0, 3));
    const base = MEMORY_BRANCH_ROOTS[branch].summary;
    const recent = recentAtoms.map((atom) => atom.summary).join(' | ');
    const timestamps = rootEntries.map((entry) => entry.createdAt).sort();
    const updated = [...rootEntries, ...topLevel].map((entry) => entry.updatedAt).sort().at(-1);
    return {
      id: memoryBranchRootId(branch),
      branch,
      childIds: topLevel.map((entry) => entry.atomId),
      scope: 'global',
      tier: InjectionTier.T1_ESSENTIAL,
      summary: `${base} ${active.length} indexed item(s).${recent ? ` Recent: ${recent}` : ''}`,
      content: '',
      retrievalKeys: unique([
        ...MEMORY_BRANCH_ROOTS[branch].keys,
        ...recentAtoms.flatMap((atom) => atom.retrievalKeys.slice(0, 4)),
      ]).slice(0, 64),
      importance: 1,
      confidence: 1,
      reason: 'Canonical virtual MemoryRepository branch root.',
      sourceRunIds: [],
      sourceStages: ['migration'],
      status: 'active',
      createdAt: timestamps[0] ?? new Date().toISOString(),
      updatedAt: updated ?? new Date().toISOString(),
      isBranchRoot: true,
    };
  }

  private async mutableAtom(nodeId: string): Promise<MemoryAtom | undefined> {
    if (isMemoryV3InternalRootId(nodeId)) return undefined;
    return this.atomStore.read(nodeId);
  }

  private async toNode(atom: MemoryAtom): Promise<MemoryNode> {
    const children = this.catalog.listChildrenByParent(atom.id, true).map((entry) => entry.atomId);
    return memoryAtomToNode(atom, children, this.ledger.publicScopeKey(atom.scope, atom.scopeKey));
  }

  private async readNodes(entries: MemoryCatalogEntry[]): Promise<MemoryNode[]> {
    return Promise.all((await this.readAtoms(entries)).map((atom) => this.toNode(atom)));
  }

  private async readAtoms(entries: MemoryCatalogEntry[]): Promise<MemoryAtom[]> {
    const atoms: MemoryAtom[] = [];
    for (let start = 0; start < entries.length; start += 64) {
      const batch = await Promise.all(entries.slice(start, start + 64).map((entry) => this.atomStore.read(entry.atomId)));
      for (const atom of batch) if (atom) atoms.push(atom);
    }
    return atoms;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

function boundedRecentNodeLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value! <= 0) return 256;
  return Math.min(value!, 256);
}

function confidenceSupport(
  classification: ClassifiedMemoryStatement,
  hasNewSource: boolean,
  hasNewEvidence: boolean,
): boolean {
  if (hasNewEvidence) return true;
  return hasNewSource
    && classification.assertedBy.kind === 'user'
    && ['instruction', 'goal', 'preference', 'value', 'decision', 'approval']
      .includes(classification.statementKind);
}
