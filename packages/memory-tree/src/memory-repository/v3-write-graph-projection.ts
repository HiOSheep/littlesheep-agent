// Projects bounded write hints into durable entities and commit-gated relations.

import type { MemoryWriteIntent } from '../types.js';
import type { MemoryCatalog } from '../v3/catalog.js';
import type {
  MemoryAtom,
  MemoryEntity,
  MemoryRelation,
  MemoryWriteRelationHint,
} from '../v3/contracts.js';
import type { MemoryV3GraphStore } from '../v3/graph-store.js';
import {
  memoryV3EntityId,
  memoryV3RelationId,
  scopeEntity,
  sourceEntity,
} from './v3-node-mapping.js';
import type { ClassifiedMemoryStatement } from './v3-statement.js';
import {
  assertEntityBoundary,
  assertRelationBoundary,
  buildHintedEntity,
  normalizeEntityHints,
  normalizeRelationHints,
  relationAuthorityScope,
  relationBaseRelevance,
  relationConfidence,
  relationEquivalent,
  relationResolution,
  strongerAuthority,
  strongerRelationResolution,
  uniqueStrings,
} from './v3-write-graph-policy.js';
import {
  activateMemoryRelationsForAtom,
  reconcileMemoryRelations,
  type MemoryV3RelationProjectionRecovery,
} from './v3-write-graph-activation.js';

const MAX_EXPLICIT_REFS = 64;

export interface MemoryV3PreparedWriteGraph {
  entityRefs: string[];
  relationRefs: string[];
}

export type { MemoryV3RelationProjectionRecovery } from './v3-write-graph-activation.js';

export class MemoryV3WriteGraphProjection {
  constructor(
    private readonly graphStore: MemoryV3GraphStore,
    private readonly catalog: MemoryCatalog,
  ) {}

  async prepare(
    intent: MemoryWriteIntent,
    classification: ClassifiedMemoryStatement,
    storageScopeKey: string | undefined,
  ): Promise<MemoryV3PreparedWriteGraph> {
    const entityRefs = new Set<string>();
    const relationRefs = new Set<string>();

    for (const id of classification.entityRefs.slice(0, MAX_EXPLICIT_REFS)) {
      const entity = await this.graphStore.getEntity(id);
      if (!entity) throw new Error(`Memory entity does not exist: ${id}`);
      assertEntityBoundary(entity, intent.scope, storageScopeKey);
      if (entity.status !== 'active') throw new Error(`Memory entity is not active: ${id}`);
      entityRefs.add(id);
    }
    for (const id of classification.relationRefs.slice(0, MAX_EXPLICIT_REFS)) {
      const relation = await this.graphStore.getRelation(id);
      if (!relation) throw new Error(`Memory relation does not exist: ${id}`);
      assertRelationBoundary(relation, intent.scope, storageScopeKey);
      if (relation.status === 'archived' || relation.status === 'deleted') {
        throw new Error(`Memory relation is not referenceable: ${id}`);
      }
      relationRefs.add(id);
    }

    const now = intent.createdAt ?? new Date().toISOString();
    await this.ensureAmbientEntities(intent, classification, storageScopeKey, now, entityRefs);
    const hinted = await this.ensureHintedEntities(intent, classification, storageScopeKey, now);
    for (const entity of hinted.values()) entityRefs.add(entity.id);

    for (const hint of normalizeRelationHints(classification.relationHints, hinted)) {
      const from = hinted.get(hint.fromKey);
      const to = hinted.get(hint.toKey);
      if (!from || !to) continue;
      const relation = await this.ensureRelation({
        intent,
        classification,
        storageScopeKey,
        now,
        hint,
        fromEntityId: from.id,
        toEntityId: to.id,
      });
      if (relation && relation.status !== 'archived' && relation.status !== 'deleted') {
        relationRefs.add(relation.id);
      }
    }

    return {
      entityRefs: [...entityRefs].slice(0, 256),
      relationRefs: [...relationRefs].slice(0, 256),
    };
  }

  async activateForAtom(atom: MemoryAtom): Promise<string[]> {
    return activateMemoryRelationsForAtom(this.graphStore, this.catalog, atom);
  }

  async reconcile(limit?: number): Promise<MemoryV3RelationProjectionRecovery> {
    return reconcileMemoryRelations(this.graphStore, this.catalog, limit);
  }

  private async ensureAmbientEntities(
    intent: MemoryWriteIntent,
    classification: ClassifiedMemoryStatement,
    storageScopeKey: string | undefined,
    now: string,
    refs: Set<string>,
  ): Promise<void> {
    const scopeEntityId = intent.scope === 'global' || !storageScopeKey
      ? undefined
      : memoryV3EntityId(
          intent.scope === 'workspace' ? 'directory' : intent.scope,
          intent.scope,
          storageScopeKey,
          storageScopeKey,
        );
    const scoped = scopeEntity(
      intent.scope,
      storageScopeKey,
      intent.scopeKey,
      now,
      scopeEntityId ? await this.graphStore.getEntity(scopeEntityId) : undefined,
    );
    if (scoped) {
      const persisted = await this.graphStore.upsertEntity(scoped);
      refs.add(persisted.id);
    }
    for (const sourceRef of intent.sourceRefs ?? []) {
      const candidate = sourceEntity(sourceRef, intent.scope, storageScopeKey, now);
      const existing = await this.graphStore.getEntity(candidate.id);
      const persisted = await this.graphStore.upsertEntity(sourceEntity(
        sourceRef,
        intent.scope,
        storageScopeKey,
        now,
        existing,
      ));
      refs.add(persisted.id);
    }
    if (classification.assertedBy.kind === 'user' && classification.assertedBy.id) {
      const stableKey = `user:${classification.assertedBy.id}`;
      const id = memoryV3EntityId('user', intent.scope, storageScopeKey, stableKey);
      const existing = await this.graphStore.getEntity(id);
      const entity = buildHintedEntity({
        hint: { stableKey, type: 'user', label: classification.assertedBy.label ?? 'Local user' },
        intent,
        classification,
        storageScopeKey,
        now,
        existing,
      });
      if (entity) refs.add((await this.graphStore.upsertEntity(entity)).id);
    }
  }

  private async ensureHintedEntities(
    intent: MemoryWriteIntent,
    classification: ClassifiedMemoryStatement,
    storageScopeKey: string | undefined,
    now: string,
  ): Promise<Map<string, MemoryEntity>> {
    const entities = new Map<string, MemoryEntity>();
    for (const hint of normalizeEntityHints(classification.entityHints)) {
      if (hint.type === 'user' && classification.assertedBy.kind !== 'user') continue;
      const id = memoryV3EntityId(hint.type, intent.scope, storageScopeKey, hint.stableKey);
      const existing = await this.graphStore.getEntity(id);
      const entity = buildHintedEntity({ hint, intent, classification, storageScopeKey, now, existing });
      if (!entity) continue;
      entities.set(hint.stableKey, await this.graphStore.upsertEntity(entity));
    }
    return entities;
  }

  private async ensureRelation(input: {
    intent: MemoryWriteIntent;
    classification: ClassifiedMemoryStatement;
    storageScopeKey: string | undefined;
    now: string;
    hint: MemoryWriteRelationHint;
    fromEntityId: string;
    toEntityId: string;
  }): Promise<MemoryRelation | undefined> {
    const id = memoryV3RelationId(
      input.hint.type,
      input.intent.scope,
      input.storageScopeKey,
      input.fromEntityId,
      input.toEntityId,
    );
    const existing = await this.graphStore.getRelation(id);
    if (existing?.status === 'archived' || existing?.status === 'deleted') return undefined;
    if (existing) assertRelationBoundary(existing, input.intent.scope, input.storageScopeKey);
    const sourceRefs = uniqueStrings([
      ...(existing?.sourceRefs ?? []),
      ...(input.intent.sourceRefs ?? []).filter((ref) => ref.startsWith('conversation-source:')),
    ], 256);
    const evidenceRefs = uniqueStrings([
      ...(existing?.evidenceRefs ?? []),
      ...input.classification.evidenceRefs,
    ], 256);
    if (sourceRefs.length === 0 && evidenceRefs.length === 0) return undefined;
    const desiredResolution = relationResolution(input.classification);
    const resolutionStatus = existing
      ? strongerRelationResolution(existing.resolutionStatus, desiredResolution)
      : desiredResolution;
    const authorityScope = relationAuthorityScope(
      input.classification.authorityScope,
      input.intent.scope,
      input.storageScopeKey,
    );
    const confidence = Math.max(existing?.confidence ?? 0, relationConfidence(input.classification));
    const next: MemoryRelation = {
      version: 1,
      id,
      fromEntityId: input.fromEntityId,
      toEntityId: input.toEntityId,
      type: input.hint.type,
      scope: input.intent.scope,
      scopeKey: input.storageScopeKey,
      source: existing?.source ?? input.classification.assertedBy,
      sourceRefs,
      evidenceRefs,
      confidence,
      authorityScope: strongerAuthority(existing?.authorityScope, authorityScope),
      relevance: existing?.relevance ?? relationBaseRelevance(input.hint.type),
      feedbackRevision: existing?.feedbackRevision ?? 0,
      recentFeedbackIds: existing?.recentFeedbackIds ?? [],
      effectiveAt: existing?.effectiveAt ?? input.now,
      expiresAt: existing?.expiresAt,
      status: existing?.status ?? 'proposed',
      resolutionStatus,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    if (existing && relationEquivalent(existing, next)) return existing;
    return this.graphStore.upsertRelation(next);
  }
}
