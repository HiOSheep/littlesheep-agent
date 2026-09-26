// Owns atom projection lifecycle without modifying immutable conversation sources.

import { randomUUID } from 'node:crypto';
import type { MemoryAtomStore } from '../v3/atom-store.js';
import type { MemoryCatalog } from '../v3/catalog.js';
import type { MemoryAtom, MemoryAtomPatch, MemoryRelation } from '../v3/contracts.js';
import type { MemoryV3StorageCoordinator } from '../v3/storage-coordinator.js';
import { sha256Canonical } from '../v3/durable-json.js';
import type {
  MemoryAtomManagementAudit,
  MemoryAtomManagementRequest,
  MemoryAtomManagementResult,
  MemoryAtomRevisionPatch,
} from './management.js';
import { isMemoryV3InternalRootId, memoryV3ScopeRootId } from './v3-node-mapping.js';
import { memoryBranchRootId } from './document-store.js';
import { repositoryEvent } from './v3-node-transitions.js';
import { sameStatementCategory } from './v3-statement.js';
import { cleanText, unique } from './text.js';

export interface MemoryV3AtomManagementOptions {
  atomStore: MemoryAtomStore;
  catalog: MemoryCatalog;
  coordinator: MemoryV3StorageCoordinator;
  /** Graph projection port; required only to record a user-authorized correction relation. */
  relations?: MemoryCorrectionRelationPort;
  now?: () => Date;
}

/**
 * The one place a correction relation is created rather than proposed. Ordinary writes leave a
 * relation `proposed` until evidence settles it; a correction the user stated in their own words is
 * already settled, and the alternative — refusing every correction until some unrelated process
 * resolves a relation — would silently turn "记错了，是 6432" into a second contradictory fact.
 */
export interface MemoryCorrectionRelationPort {
  upsertRelation(relation: MemoryRelation): Promise<MemoryRelation>;
  getRelation(id: string): Promise<MemoryRelation | undefined>;
  getEntity(id: string): Promise<{ id: string; status: string } | undefined>;
}

export interface MemoryCorrectionRelationRequest {
  supersededAtomId: string;
  replacementAtomId: string;
  /** Runtime evidence: the user messages that asked for the correction. */
  sourceRefs: string[];
  reason: string;
}

type MemoryAtomLifecycleRequest = Extract<
  MemoryAtomManagementRequest,
  { action: 'invalidate' | 'reactivate' }
>;

export class MemoryV3AtomManagement {
  private readonly atomStore: MemoryAtomStore;
  private readonly catalog: MemoryCatalog;
  private readonly coordinator: MemoryV3StorageCoordinator;
  private readonly relations: MemoryCorrectionRelationPort | undefined;
  private readonly now: () => Date;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryV3AtomManagementOptions) {
    this.atomStore = options.atomStore;
    this.catalog = options.catalog;
    this.coordinator = options.coordinator;
    this.relations = options.relations;
    this.now = options.now ?? (() => new Date());
  }

  manage(request: MemoryAtomManagementRequest): Promise<MemoryAtomManagementResult> {
    return this.exclusive(async () => {
      const reason = managementReason(request.reason);
      if (request.action === 'move') return this.move(request, reason);
      if (request.action === 'merge') return this.merge(request, reason);
      if (request.action === 'revise') return this.revise(request, reason);
      if (request.action === 'supersede') return this.supersede(request, reason);
      if (request.action === 'invalidate') return this.invalidate(request, reason);
      return this.reactivate(request, reason);
    });
  }

  /**
   * Records the user-authorized `replaces` relation a correction needs before it may supersede. It is
   * deliberately narrow: both atoms must exist, share the subject entity, and sit in the same branch
   * and scope, the evidence must be real runtime source refs, and the id is derived from the request
   * so a retry reuses the same relation instead of stacking a second one.
   */
  relateCorrection(request: MemoryCorrectionRelationRequest): Promise<string> {
    return this.exclusive(async () => {
      if (!this.relations) throw new Error('This repository cannot record correction relations.')
      const sourceRefs = unique(request.sourceRefs.map((ref) => ref.trim()).filter(Boolean))
      if (sourceRefs.length === 0) throw new Error('A correction relation needs runtime evidence references.')
      const [superseded, replacement] = await Promise.all([
        this.requiredAtom(request.supersededAtomId),
        this.requiredAtom(request.replacementAtomId),
      ])
      if (superseded.id === replacement.id) throw new Error('A memory atom cannot replace itself.')
      if (superseded.branch !== replacement.branch
        || superseded.scope !== replacement.scope
        || (superseded.scopeKey ?? '') !== (replacement.scopeKey ?? '')) {
        throw new Error('A correction relation cannot cross branch, scope, or scopeKey boundaries.')
      }
      const at = this.now().toISOString()
      // The two endpoints have to be two distinct entities, each belonging to its own side of the
      // correction: the replacement's own entity replaces the superseded atom's own entity. Preferring
      // an entity that only one side carries keeps the direction meaningful.
      const fromEntityId = replacement.entityRefs.find((id) => !superseded.entityRefs.includes(id))
        ?? replacement.entityRefs[0]
      const toEntityId = superseded.entityRefs.find((id) => id !== fromEntityId && !replacement.entityRefs.includes(id))
        ?? superseded.entityRefs.find((id) => id !== fromEntityId)
      if (!fromEntityId || !toEntityId) {
        throw new Error('A correction relation needs an entity on each side of the correction.')
      }
      const entity = await this.relations.getEntity(fromEntityId)
      if (!entity) {
        throw new Error(`The replacement's entity is not in the graph: ${fromEntityId}`)
      }
      if (entity.status !== 'active') {
        throw new Error(`The replacement's entity is not active: ${fromEntityId}`)
      }
      const id = `memory-relation:user-correction:${sha256Canonical([
        superseded.id, replacement.id, fromEntityId, toEntityId, sourceRefs,
      ]).slice(0, 32)}`
      const existing = await this.relations.getRelation(id)
      const relation: MemoryRelation = {
        version: 1,
        id,
        fromEntityId,
        toEntityId,
        type: 'replaces',
        scope: superseded.scope,
        scopeKey: superseded.scopeKey,
        source: { kind: 'user', id: 'local-user' },
        sourceRefs,
        evidenceRefs: [`memory-atom:${superseded.id}@${superseded.revision}`, `memory-atom:${replacement.id}@${replacement.revision}`],
        confidence: 0.9,
        authorityScope: {
          kind: 'user-self',
          scope: superseded.scope,
          scopeKey: superseded.scope === 'global' ? undefined : superseded.scopeKey,
          topics: [],
        },
        relevance: 0.9,
        status: 'active',
        resolutionStatus: 'resolved',
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      }
      const stored = await this.relations.upsertRelation(relation).catch((error: unknown) => {
        throw new Error(
          `Recording the correction relation ${id} between ${relation.fromEntityId} and ${relation.toEntityId} failed: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      })
      return stored.id
    })
  }

  private async supersede(
    request: Extract<MemoryAtomManagementRequest, { action: 'supersede' }>,
    reason: string,
  ): Promise<MemoryAtomManagementResult> {
    if (request.atomId === request.replacementAtomId) {
      throw new Error('A memory atom cannot supersede itself.');
    }
    const [atom, replacement] = await Promise.all([
      this.requiredAtom(request.atomId, request.expectedRevision),
      this.requiredAtom(request.replacementAtomId, request.replacementExpectedRevision),
    ]);
    assertCorrectionEligible(atom, 'superseded');
    assertCorrectionEligible(replacement, 'replacement');
    assertSameBoundary(atom, replacement, 'supersession');
    if ((atom.parentId ?? '') !== (replacement.parentId ?? '')) {
      throw new Error('A correction replacement must remain under the same semantic parent.');
    }
    if (atom.domain !== replacement.domain || atom.statementKind !== replacement.statementKind) {
      throw new Error('A correction replacement cannot cross domain or statement-kind boundaries.');
    }
    const at = this.now().toISOString();
    const before = [auditState(atom)];
    const event = repositoryEvent(
      atom,
      `atom-management:supersede:${replacement.id}:${request.relationId}`,
      'conflict-resolution',
      {
        atomManagement: {
          action: 'supersede',
          reason,
          replacementAtomId: replacement.id,
          relationId: request.relationId,
          priorProjection: {
            title: atom.title,
            summary: atom.summary,
            content: atom.content,
            contentHash: atom.contentHash,
          },
        },
      },
    );
    event.source = { kind: 'agent', id: 'memory-v3-runtime' };
    event.evidenceRefs = boundedUnique([
      ...(request.evidenceRefs ?? []),
      `memory-atom:${atom.id}@${atom.revision}`,
      `memory-atom:${replacement.id}@${replacement.revision}`,
      `memory-relation:${request.relationId}`,
    ], 256);
    const updated = await this.coordinator.apply(
      event,
      {
        kind: 'update',
        atomId: atom.id,
        expectedRevision: atom.revision,
        patch: {
          epistemicStatus: 'superseded',
          resolutionStatus: 'superseded',
          supersession: {
            byAtomId: replacement.id,
            relationId: request.relationId,
            at,
            reason,
            priorEpistemicStatus: atom.epistemicStatus,
            priorResolutionStatus: atom.resolutionStatus,
          },
        },
      },
    );
    return result('supersede', [updated], before, reason, new Date(at));
  }

  private async revise(
    request: Extract<MemoryAtomManagementRequest, { action: 'revise' }>,
    reason: string,
  ): Promise<MemoryAtomManagementResult> {
    const atom = await this.requiredAtom(request.atomId, request.expectedRevision);
    if (atom.status !== 'active') throw new Error('Only active memory atoms can be revised.');
    if (atom.invalidation) throw new Error('Invalidated memory atoms cannot be revised.');
    if (atom.merge) throw new Error('Merged memory atoms cannot be revised.');
    if (atom.supersession) throw new Error('Superseded memory atoms cannot be revised.');
    if (atom.epistemicStatus === 'disputed' || atom.epistemicStatus === 'superseded'
      || atom.resolutionStatus === 'rejected' || atom.resolutionStatus === 'superseded') {
      throw new Error('Memory atom is outside the safe same-claim revision boundary.');
    }
    const patch = normalizedRevisionPatch(request.patch);
    if (sameRevisionProjection(atom, patch)) {
      throw new Error('The memory atom already has the requested revision projection.');
    }
    const before = [auditState(atom)];
    const event = repositoryEvent(atom, 'atom-management:revise', 'configuration-change', {
      atomManagement: {
        action: 'revise',
        reason,
        priorProjection: {
          title: atom.title,
          summary: atom.summary,
          content: atom.content,
          retrievalKeys: [...atom.retrievalKeys],
          contentHash: atom.contentHash,
        },
        replacement: patch,
      },
    });
    event.source = { kind: 'agent', id: 'memory-v3-runtime' };
    event.evidenceRefs = boundedUnique([
      ...(request.evidenceRefs ?? []),
      `memory-atom:${atom.id}@${atom.revision}`,
    ], 256);
    const updated = await this.coordinator.apply(
      event,
      {
        kind: 'update',
        atomId: atom.id,
        expectedRevision: atom.revision,
        patch,
      },
    );
    return result('revise', [updated], before, reason, this.now());
  }

  private async move(
    request: Extract<MemoryAtomManagementRequest, { action: 'move' }>,
    reason: string,
  ): Promise<MemoryAtomManagementResult> {
    const atom = await this.requiredAtom(request.atomId, request.expectedRevision);
    const parent = await this.resolveMoveParent(atom, request.parentNodeId);
    if (parent) {
      if (parent.status === 'tombstone') throw new Error('A memory atom cannot move under a tombstone parent.');
      assertSameBoundary(atom, parent, 'move');
    }
    if ((atom.parentId ?? '') === (parent?.id ?? '')) {
      throw new Error('The memory atom already has the requested parent.');
    }
    const before = [auditState(atom)];
    const updated = await this.coordinator.apply(
      repositoryEvent(atom, `atom-management:move:${parent?.id ?? 'root'}`, 'configuration-change', {
        atomManagement: { action: 'move', reason, parentNodeId: parent?.id },
      }),
      {
        kind: 'update',
        atomId: atom.id,
        expectedRevision: atom.revision,
        patch: { parentId: parent?.id },
      },
    );
    return result('move', [updated], before, reason, this.now());
  }

  private async merge(
    request: Extract<MemoryAtomManagementRequest, { action: 'merge' }>,
    reason: string,
  ): Promise<MemoryAtomManagementResult> {
    if (request.atomId === request.targetAtomId) throw new Error('A memory atom cannot be merged into itself.');
    const [source, target] = await Promise.all([
      this.requiredAtom(request.atomId, request.expectedRevision),
      this.requiredAtom(request.targetAtomId, request.targetExpectedRevision),
    ]);
    assertMergeEligible(source, 'source');
    assertMergeEligible(target, 'target');
    assertSameBoundary(source, target, 'merge');
    if ((source.parentId ?? '') !== (target.parentId ?? '')) {
      throw new Error('Memory atoms must share the same parent before they can be merged.');
    }
    if (!sameStatementCategory(source, target)
      || canonical(source.authorityScope) !== canonical(target.authorityScope)
      || canonical(source.assertedBy) !== canonical(target.assertedBy)
      || source.epistemicStatus !== target.epistemicStatus
      || source.resolutionStatus !== target.resolutionStatus) {
      throw new Error('Memory atoms cross an epistemic boundary and cannot be merged.');
    }
    if (this.catalog.listChildrenByParent(source.id, true).length > 0) {
      throw new Error('Move or manage child atoms before merging their source parent.');
    }
    const at = this.now().toISOString();
    const before = [auditState(target), auditState(source)];
    const targetPatch: MemoryAtomPatch = {
      sourceRefs: boundedUnique([...target.sourceRefs, ...source.sourceRefs], 256),
      evidenceRefs: boundedUnique([...target.evidenceRefs, ...source.evidenceRefs], 256),
      entityRefs: boundedUnique([...target.entityRefs, ...source.entityRefs], 256),
      relationRefs: boundedUnique([...target.relationRefs, ...source.relationRefs], 256),
      retrievalKeys: boundedUnique([...target.retrievalKeys, ...source.retrievalKeys], 128),
      sourceRunIds: boundedUnique([...target.sourceRunIds, ...source.sourceRunIds], 256),
      sourceStages: unique([...target.sourceStages, ...source.sourceStages]).slice(0, 64),
      mergedFromAtomIds: boundedUnique([
        ...(target.mergedFromAtomIds ?? []),
        source.id,
        ...(source.mergedFromAtomIds ?? []),
      ], 256),
    };
    const sourcePatch: MemoryAtomPatch = {
      status: 'tombstone',
      merge: { intoAtomId: target.id, at, reason },
    };
    const updatedTarget = await this.coordinator.apply(
      repositoryEvent(target, `atom-management:merge:${source.id}`, 'configuration-change', {
        atomManagement: { action: 'merge', reason, sourceAtomId: source.id, targetAtomId: target.id },
      }),
      {
        kind: 'merge',
        targetAtomId: target.id,
        targetExpectedRevision: target.revision,
        targetPatch,
        sourceAtomId: source.id,
        sourceExpectedRevision: source.revision,
        sourcePatch,
      },
    );
    const updatedSource = await this.requiredAtom(source.id);
    return result('merge', [updatedTarget, updatedSource], before, reason, new Date(at));
  }

  private async invalidate(
    request: MemoryAtomLifecycleRequest,
    reason: string,
  ): Promise<MemoryAtomManagementResult> {
    const atom = await this.requiredAtom(request.atomId, request.expectedRevision);
    if (atom.status !== 'active') throw new Error('Only active memory atoms can be invalidated.');
    if (atom.merge) throw new Error('A merged memory atom cannot be invalidated.');
    if (atom.supersession) throw new Error('A superseded memory atom cannot be invalidated again.');
    if (atom.invalidation) throw new Error('This memory atom is already invalidated.');
    const at = this.now().toISOString();
    const before = [auditState(atom)];
    const updated = await this.coordinator.apply(
      repositoryEvent(atom, 'atom-management:invalidate', 'configuration-change', {
        atomManagement: { action: 'invalidate', reason },
      }),
      {
        kind: 'update', atomId: atom.id, expectedRevision: atom.revision,
        patch: {
          invalidation: {
            at,
            reason,
            priorEpistemicStatus: atom.epistemicStatus,
            priorResolutionStatus: atom.resolutionStatus,
          },
          epistemicStatus: 'superseded',
          resolutionStatus: 'superseded',
        },
      },
    );
    return result('invalidate', [updated], before, reason, new Date(at));
  }

  private async reactivate(
    request: MemoryAtomLifecycleRequest,
    reason: string,
  ): Promise<MemoryAtomManagementResult> {
    const atom = await this.requiredAtom(request.atomId, request.expectedRevision);
    if (atom.status !== 'active') throw new Error('Only active invalidated atoms can be reactivated.');
    if (atom.merge) throw new Error('A merged memory atom cannot be reactivated.');
    if (!atom.invalidation) throw new Error('This memory atom is not invalidated.');
    const before = [auditState(atom)];
    const updated = await this.coordinator.apply(
      repositoryEvent(atom, 'atom-management:reactivate', 'configuration-change', {
        atomManagement: { action: 'reactivate', reason },
      }),
      {
        kind: 'update', atomId: atom.id, expectedRevision: atom.revision,
        patch: {
          epistemicStatus: atom.invalidation.priorEpistemicStatus,
          resolutionStatus: atom.invalidation.priorResolutionStatus,
          invalidation: null,
        },
      },
    );
    return result('reactivate', [updated], before, reason, this.now());
  }

  private async requiredAtom(atomId: string, expectedRevision?: number): Promise<MemoryAtom> {
    if (isMemoryV3InternalRootId(atomId)) throw new Error('Internal memory roots cannot be managed as atoms.');
    const atom = await this.atomStore.read(atomId);
    if (!atom) throw new Error(`Memory atom not found: ${atomId}`);
    if (expectedRevision !== undefined && atom.revision !== expectedRevision) {
      throw new Error(`Memory atom ${atom.id} revision conflict: expected ${expectedRevision}, found ${atom.revision}.`);
    }
    return atom;
  }

  private async resolveMoveParent(atom: MemoryAtom, requestedParentId?: string): Promise<MemoryAtom> {
    const scopeRootId = memoryV3ScopeRootId(atom.branch, atom.scope, atom.scopeKey);
    const publicBranchRootId = memoryBranchRootId(atom.branch);
    const normalized = requestedParentId?.trim();
    const parentId = !normalized || normalized === publicBranchRootId ? scopeRootId : normalized;
    const parent = await this.atomStore.read(parentId);
    if (!parent) throw new Error(`Memory move parent not found: ${parentId}.`);
    if (parent.status === 'tombstone') throw new Error('A memory atom cannot move under a tombstone parent.');
    return parent;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function assertSameBoundary(left: MemoryAtom, right: MemoryAtom, action: string): void {
  if (left.branch !== right.branch
    || left.scope !== right.scope
    || (left.scopeKey ?? '') !== (right.scopeKey ?? '')) {
    throw new Error(`Memory atom ${action} cannot cross branch, scope, or scopeKey boundaries.`);
  }
}

function assertMergeEligible(atom: MemoryAtom, role: string): void {
  if (atom.status !== 'active') throw new Error(`The merge ${role} must be active.`);
  if (atom.invalidation) throw new Error(`The merge ${role} is invalidated.`);
  if (atom.merge) throw new Error(`The merge ${role} has already been merged.`);
  if (atom.supersession) throw new Error(`The merge ${role} has already been superseded.`);
}

function assertCorrectionEligible(atom: MemoryAtom, role: string): void {
  if (atom.status !== 'active') throw new Error(`The correction ${role} Atom must be active.`);
  if (atom.invalidation) throw new Error(`The correction ${role} Atom is invalidated.`);
  if (atom.merge) throw new Error(`The correction ${role} Atom has already been merged.`);
  if (atom.supersession) throw new Error(`The correction ${role} Atom has already been superseded.`);
}

function result(
  action: MemoryAtomManagementRequest['action'],
  atoms: MemoryAtom[],
  before: MemoryAtomManagementAudit['before'],
  reason: string,
  at: Date,
): MemoryAtomManagementResult {
  const audit: MemoryAtomManagementAudit = {
    id: randomUUID(),
    action,
    at: at.toISOString(),
    reason,
    atomIds: atoms.map((atom) => atom.id),
    before,
    after: atoms.map(auditState),
  };
  return { action, atoms: atoms.map((atom) => structuredClone(atom)), audit };
}

function auditState(atom: MemoryAtom): MemoryAtomManagementAudit['before'][number] {
  return {
    atomId: atom.id,
    revision: atom.revision,
    contentHash: atom.contentHash,
    parentId: atom.parentId,
    status: atom.status,
    epistemicStatus: atom.epistemicStatus,
    resolutionStatus: atom.resolutionStatus,
  };
}

function normalizedRevisionPatch(patch: MemoryAtomRevisionPatch): MemoryAtomRevisionPatch {
  const title = cleanText(patch.title);
  const summary = cleanText(patch.summary);
  const content = cleanText(patch.content);
  const retrievalKeys = boundedUnique(patch.retrievalKeys, 64);
  if (!title || title.length > 500) throw new Error('A revised memory atom title is invalid.');
  if (!summary || summary.length > 8_000) throw new Error('A revised memory atom summary is invalid.');
  if (!content || content.length > 12_000) throw new Error('A revised memory atom content is invalid.');
  if (retrievalKeys.length === 0) throw new Error('A revised memory atom needs retrieval keys.');
  return { title, summary, content, retrievalKeys };
}

function sameRevisionProjection(atom: MemoryAtom, patch: MemoryAtomRevisionPatch): boolean {
  return atom.title === patch.title
    && atom.summary === patch.summary
    && atom.content === patch.content
    && JSON.stringify(atom.retrievalKeys) === JSON.stringify(patch.retrievalKeys);
}

function managementReason(value: string): string {
  return cleanText(value).slice(0, 2_000) || 'Changed by the user through Memory v3 atom management.';
}

function boundedUnique(values: string[], limit: number): string[] {
  return unique(values.map((value) => cleanText(value)).filter(Boolean)).slice(0, limit);
}

function canonical(value: unknown): string {
  return sha256Canonical(value);
}
