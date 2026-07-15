import type { DatabaseSync } from 'node:sqlite';
import type { MemoryEntity, MemoryRelation } from './contracts.js';
import { assertScope } from './catalog-helpers.js';

export interface MemoryEntityReferenceBlockers {
  atomIds: string[];
  inboundRelationIds: string[];
  outboundRelationIds: string[];
}

export interface MemoryRelationReferenceBlockers {
  atomIds: string[];
}

export function upsertMemoryEntity(db: DatabaseSync, entity: MemoryEntity): void {
  assertScope(entity);
  const existing = db.prepare('SELECT status FROM entities WHERE entity_id = ?')
    .get(entity.id) as { status: MemoryEntity['status'] } | undefined;
  if (existing?.status === 'active' && entity.status !== 'active') {
    const blockers = memoryEntityReferenceBlockers(db, entity.id, false);
    if (hasEntityBlockers(blockers)) {
      throw new Error(`Memory entity ${entity.id} cannot leave active state while references remain: ${JSON.stringify(blockers)}`);
    }
  }
  db.prepare(`
    INSERT INTO entities (
      entity_id, entity_type, owner_json, scope, scope_key, external_key,
      label, aliases_json, status, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET
      entity_type = excluded.entity_type,
      owner_json = excluded.owner_json,
      scope = excluded.scope,
      scope_key = excluded.scope_key,
      external_key = excluded.external_key,
      label = excluded.label,
      aliases_json = excluded.aliases_json,
      status = excluded.status,
      revision = excluded.revision,
      updated_at = excluded.updated_at
  `).run(
    entity.id,
    entity.type,
    JSON.stringify(entity.owner),
    entity.scope,
    entity.scopeKey ?? null,
    entity.externalKey ?? null,
    entity.label,
    JSON.stringify(entity.aliases),
    entity.status,
    entity.revision,
    entity.createdAt,
    entity.updatedAt,
  );
}

export function upsertMemoryRelation(db: DatabaseSync, relation: MemoryRelation): void {
  assertScope(relation);
  const existing = db.prepare('SELECT status FROM relations WHERE relation_id = ?')
    .get(relation.id) as { status: MemoryRelation['status'] } | undefined;
  if (existing && !['archived', 'deleted'].includes(existing.status) && ['archived', 'deleted'].includes(relation.status)) {
    const blockers = memoryRelationReferenceBlockers(db, relation.id);
    if (blockers.atomIds.length > 0) {
      throw new Error(`Memory relation ${relation.id} cannot be archived or deleted while atom references remain: ${JSON.stringify(blockers)}`);
    }
  }
  const entities = db.prepare(`
    SELECT entity_id, scope, scope_key, status FROM entities WHERE entity_id IN (?, ?)
  `).all(relation.fromEntityId, relation.toEntityId) as unknown as Array<{
    entity_id: string;
    scope: string;
    scope_key: string | null;
    status: MemoryEntity['status'];
  }>;
  if (entities.length !== 2) throw new Error('Memory relation endpoints must both exist.');
  if (entities.some((entity) => entity.status !== 'active')) {
    throw new Error('Memory relation endpoints must both be active.');
  }
  if (entities.some((entity) => entity.scope !== relation.scope || entity.scope_key !== (relation.scopeKey ?? null))) {
    throw new Error('Memory relation cannot cross entity scope boundaries without an explicit propagation rule.');
  }
  db.prepare(`
    INSERT INTO relations (
      relation_id, from_entity_id, to_entity_id, relation_type, scope, scope_key,
      source_json, evidence_refs_json, confidence, authority_scope_json, relevance,
      effective_at, expires_at, status, resolution_status, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(relation_id) DO UPDATE SET
      from_entity_id = excluded.from_entity_id,
      to_entity_id = excluded.to_entity_id,
      relation_type = excluded.relation_type,
      source_json = excluded.source_json,
      evidence_refs_json = excluded.evidence_refs_json,
      confidence = excluded.confidence,
      authority_scope_json = excluded.authority_scope_json,
      relevance = excluded.relevance,
      effective_at = excluded.effective_at,
      expires_at = excluded.expires_at,
      status = excluded.status,
      resolution_status = excluded.resolution_status,
      revision = excluded.revision,
      updated_at = excluded.updated_at
  `).run(
    relation.id,
    relation.fromEntityId,
    relation.toEntityId,
    relation.type,
    relation.scope,
    relation.scopeKey ?? null,
    JSON.stringify(relation.source),
    JSON.stringify(relation.evidenceRefs),
    relation.confidence,
    JSON.stringify(relation.authorityScope),
    relation.relevance,
    relation.effectiveAt ?? null,
    relation.expiresAt ?? null,
    relation.status,
    relation.resolutionStatus,
    relation.revision,
    relation.createdAt,
    relation.updatedAt,
  );
}

export function memoryEntityReferenceBlockers(
  db: DatabaseSync,
  entityId: string,
  includeArchivedRelations = true,
): MemoryEntityReferenceBlockers {
  const atomIds = rowsToIds(db.prepare(`
    SELECT atom_id AS id FROM atom_entity_refs WHERE entity_id = ? ORDER BY atom_id ASC
  `).all(entityId));
  const relationFilter = includeArchivedRelations ? '' : "AND status NOT IN ('archived', 'deleted')";
  const inboundRelationIds = rowsToIds(db.prepare(`
    SELECT relation_id AS id FROM relations WHERE to_entity_id = ? ${relationFilter} ORDER BY relation_id ASC
  `).all(entityId));
  const outboundRelationIds = rowsToIds(db.prepare(`
    SELECT relation_id AS id FROM relations WHERE from_entity_id = ? ${relationFilter} ORDER BY relation_id ASC
  `).all(entityId));
  return { atomIds, inboundRelationIds, outboundRelationIds };
}

export function memoryRelationReferenceBlockers(
  db: DatabaseSync,
  relationId: string,
): MemoryRelationReferenceBlockers {
  return {
    atomIds: rowsToIds(db.prepare(`
      SELECT atom_id AS id FROM atom_relation_refs WHERE relation_id = ? ORDER BY atom_id ASC
    `).all(relationId)),
  };
}

function hasEntityBlockers(blockers: MemoryEntityReferenceBlockers): boolean {
  return blockers.atomIds.length > 0
    || blockers.inboundRelationIds.length > 0
    || blockers.outboundRelationIds.length > 0;
}

function rowsToIds(rows: unknown[]): string[] {
  return (rows as Array<{ id: string }>).map((row) => row.id);
}
