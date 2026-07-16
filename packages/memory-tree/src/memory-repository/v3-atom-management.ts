// Owns atom projection lifecycle without modifying immutable conversation sources.

import { randomUUID } from 'node:crypto';
import type { MemoryAtomStore } from '../v3/atom-store.js';
import type { MemoryCatalog } from '../v3/catalog.js';
import type { MemoryAtom, MemoryAtomPatch } from '../v3/contracts.js';
import type { MemoryV3StorageCoordinator } from '../v3/storage-coordinator.js';
import { sha256Canonical } from '../v3/durable-json.js';
import type {
  MemoryAtomManagementAudit,
  MemoryAtomManagementRequest,
  MemoryAtomManagementResult,
} from './management.js';
import { isMemoryV3InternalRootId } from './v3-node-mapping.js';
import { repositoryEvent } from './v3-node-transitions.js';
import { sameStatementCategory } from './v3-statement.js';
import { cleanText, unique } from './text.js';

export interface MemoryV3AtomManagementOptions {
  atomStore: MemoryAtomStore;
  catalog: MemoryCatalog;
  coordinator: MemoryV3StorageCoordinator;
  now?: () => Date;
}

type MemoryAtomLifecycleRequest = Extract<
  MemoryAtomManagementRequest,
  { action: 'invalidate' | 'reactivate' }
>;

export class MemoryV3AtomManagement {
  private readonly atomStore: MemoryAtomStore;
  private readonly catalog: MemoryCatalog;
  private readonly coordinator: MemoryV3StorageCoordinator;
  private readonly now: () => Date;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: MemoryV3AtomManagementOptions) {
    this.atomStore = options.atomStore;
    this.catalog = options.catalog;
    this.coordinator = options.coordinator;
    this.now = options.now ?? (() => new Date());
  }

  manage(request: MemoryAtomManagementRequest): Promise<MemoryAtomManagementResult> {
    return this.exclusive(async () => {
      const reason = managementReason(request.reason);
      if (request.action === 'move') return this.move(request, reason);
      if (request.action === 'merge') return this.merge(request, reason);
      if (request.action === 'invalidate') return this.invalidate(request, reason);
      return this.reactivate(request, reason);
    });
  }

  private async move(
    request: Extract<MemoryAtomManagementRequest, { action: 'move' }>,
    reason: string,
  ): Promise<MemoryAtomManagementResult> {
    const atom = await this.requiredAtom(request.atomId, request.expectedRevision);
    const parent = request.parentNodeId
      ? await this.requiredAtom(request.parentNodeId)
      : undefined;
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
    parentId: atom.parentId,
    status: atom.status,
    epistemicStatus: atom.epistemicStatus,
    resolutionStatus: atom.resolutionStatus,
  };
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
