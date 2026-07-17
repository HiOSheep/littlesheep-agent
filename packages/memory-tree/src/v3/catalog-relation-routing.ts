// Finds bounded one-hop Atom candidates through trusted, scoped entity relations.

import type { DatabaseSync } from 'node:sqlite';
import type {
  AuthorityKind,
  MemoryCatalogEntry,
  MemoryRelationRouteDirection,
  MemoryRelationType,
} from './contracts.js';
import { boundedLimit, rowToEntry, type AtomRow } from './catalog-helpers.js';

const MAX_SEEDS = 8;
const MAX_RAW_ROWS = 512;
const MIN_RELATION_CONFIDENCE = 0.55;
const MIN_RELATION_RELEVANCE = 0.5;
const MIN_ROUTE_STRENGTH = 0.55;

export interface MemoryRelationRoutingCandidate {
  seedAtomId: string;
  entry: MemoryCatalogEntry;
  relationId: string;
  relationType: MemoryRelationType;
  direction: MemoryRelationRouteDirection;
  relationConfidence: number;
  relationRelevance: number;
  routeStrength: number;
}

export interface MemoryRelationRoutingOptions {
  branch: MemoryCatalogEntry['branch'];
  subtreeRootId?: string;
  limit?: number;
}

interface RelationRouteRow extends AtomRow {
  seed_atom_id: string;
  relation_id: string;
  relation_type: MemoryRelationType;
  seed_direction: MemoryRelationRouteDirection;
  relation_confidence: number;
  relation_relevance: number;
  authority_scope_json: string;
  source_refs_json: string;
  evidence_refs_json: string;
}

export function listRelationRoutingCandidates(
  db: DatabaseSync,
  seedAtomIds: readonly string[],
  options: MemoryRelationRoutingOptions,
  now: string,
): MemoryRelationRoutingCandidate[] {
  const seedIds = [...new Set(seedAtomIds.filter(Boolean))].slice(0, MAX_SEEDS);
  if (seedIds.length === 0) return [];
  const limit = boundedLimit(options.limit, 24, 100);
  const rawLimit = Math.min(MAX_RAW_ROWS, Math.max(limit * 12, 48));
  const seedValues = seedIds.map(() => '(?)').join(', ');
  const rows = db.prepare(`
    WITH RECURSIVE
    parameters(root_id) AS (SELECT CAST(? AS TEXT)),
    subtree(atom_id) AS (
      SELECT root_id FROM parameters WHERE root_id IS NOT NULL
      UNION ALL
      SELECT child.atom_id FROM atoms child JOIN subtree parent ON child.parent_id = parent.atom_id
    ),
    seed(atom_id) AS (VALUES ${seedValues}),
    seed_entities AS (
      SELECT refs.atom_id, refs.entity_id
      FROM atom_entity_refs refs JOIN seed ON seed.atom_id = refs.atom_id
    ),
    seed_edges_raw AS (
      SELECT relation_refs.atom_id AS seed_atom_id,
        relation.relation_id, relation.relation_type, relation.from_entity_id, relation.to_entity_id,
        relation.scope AS relation_scope, relation.scope_key AS relation_scope_key,
        relation.confidence AS relation_confidence, relation.relevance AS relation_relevance,
        relation.authority_scope_json, relation.source_refs_json, relation.evidence_refs_json,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM seed_entities entity
            WHERE entity.atom_id = relation_refs.atom_id AND entity.entity_id = relation.from_entity_id
          ) THEN 'outbound'
          WHEN EXISTS (
            SELECT 1 FROM seed_entities entity
            WHERE entity.atom_id = relation_refs.atom_id AND entity.entity_id = relation.to_entity_id
          ) THEN 'inbound'
          ELSE 'shared'
        END AS seed_direction,
        relation.effective_at, relation.expires_at, relation.status, relation.resolution_status
      FROM atom_relation_refs relation_refs
      JOIN seed ON seed.atom_id = relation_refs.atom_id
      JOIN relations relation ON relation.relation_id = relation_refs.relation_id

      UNION

      SELECT entity.atom_id AS seed_atom_id,
        relation.relation_id, relation.relation_type, relation.from_entity_id, relation.to_entity_id,
        relation.scope AS relation_scope, relation.scope_key AS relation_scope_key,
        relation.confidence AS relation_confidence, relation.relevance AS relation_relevance,
        relation.authority_scope_json, relation.source_refs_json, relation.evidence_refs_json,
        CASE WHEN entity.entity_id = relation.from_entity_id THEN 'outbound' ELSE 'inbound' END AS seed_direction,
        relation.effective_at, relation.expires_at, relation.status, relation.resolution_status
      FROM seed_entities entity
      JOIN relations relation
        ON relation.from_entity_id = entity.entity_id OR relation.to_entity_id = entity.entity_id
    ),
    eligible_edges AS (
      SELECT DISTINCT edge.*
      FROM seed_edges_raw edge
      JOIN atoms seed_atom ON seed_atom.atom_id = edge.seed_atom_id
      WHERE seed_atom.branch = ? AND seed_atom.status = 'active'
        AND edge.relation_scope = seed_atom.scope
        AND edge.relation_scope_key IS seed_atom.scope_key
        AND edge.status = 'active'
        AND edge.resolution_status IN ('adopted', 'resolved')
        AND edge.relation_type <> 'similar-to'
        AND edge.relation_confidence >= ?
        AND edge.relation_relevance >= ?
        AND (edge.effective_at IS NULL OR edge.effective_at <= ?)
        AND (edge.expires_at IS NULL OR edge.expires_at > ?)
    ),
    routed_edges AS (
      SELECT edge.*,
        CASE
          WHEN edge.relation_type IN ('belongs-to', 'depends-on', 'references', 'derived-from', 'affects', 'supported-by')
            AND edge.seed_direction = 'outbound' THEN edge.to_entity_id
          WHEN edge.relation_type = 'replaces' AND edge.seed_direction = 'inbound' THEN edge.from_entity_id
          WHEN edge.relation_type = 'conflicts-with' AND edge.seed_direction = 'outbound' THEN edge.to_entity_id
          WHEN edge.relation_type = 'conflicts-with' AND edge.seed_direction = 'inbound' THEN edge.from_entity_id
          ELSE NULL
        END AS target_entity_id
      FROM eligible_edges edge
    ),
    candidate_links AS (
      SELECT edge.seed_atom_id, entity_refs.atom_id AS candidate_atom_id,
        edge.relation_id, edge.relation_type, edge.seed_direction,
        edge.relation_confidence, edge.relation_relevance, edge.authority_scope_json,
        edge.source_refs_json, edge.evidence_refs_json,
        edge.relation_scope, edge.relation_scope_key
      FROM routed_edges edge
      JOIN atom_entity_refs entity_refs ON entity_refs.entity_id = edge.target_entity_id
      WHERE edge.target_entity_id IS NOT NULL

      UNION ALL

      SELECT edge.seed_atom_id, relation_refs.atom_id AS candidate_atom_id,
        edge.relation_id, edge.relation_type, edge.seed_direction,
        edge.relation_confidence, edge.relation_relevance, edge.authority_scope_json,
        edge.source_refs_json, edge.evidence_refs_json,
        edge.relation_scope, edge.relation_scope_key
      FROM routed_edges edge
      JOIN atom_relation_refs relation_refs ON relation_refs.relation_id = edge.relation_id
      WHERE edge.relation_type = 'conflicts-with'
    )
    SELECT candidate.*, link.seed_atom_id, link.relation_id, link.relation_type,
      link.seed_direction, link.relation_confidence, link.relation_relevance,
      link.authority_scope_json, link.source_refs_json, link.evidence_refs_json
    FROM candidate_links link
    JOIN atoms candidate ON candidate.atom_id = link.candidate_atom_id
    WHERE candidate.atom_id <> link.seed_atom_id
      AND candidate.branch = ?
      AND candidate.scope = link.relation_scope
      AND candidate.scope_key IS link.relation_scope_key
      AND candidate.status = 'active'
      AND ((SELECT root_id FROM parameters) IS NULL OR candidate.atom_id IN (SELECT atom_id FROM subtree))
    ORDER BY link.relation_relevance DESC, link.relation_confidence DESC,
      candidate.updated_at DESC, candidate.atom_id ASC
    LIMIT ?
  `).all(
    options.subtreeRootId ?? null,
    ...seedIds,
    options.branch,
    MIN_RELATION_CONFIDENCE,
    MIN_RELATION_RELEVANCE,
    now,
    now,
    options.branch,
    rawLimit,
  ) as unknown as RelationRouteRow[];

  const selected = new Map<string, MemoryRelationRoutingCandidate>();
  for (const row of rows) {
    const authority = relationAuthorityWeight(row.authority_scope_json, row.scope, row.scope_key);
    if (authority === 0 || !hasTraceableRelationEvidence(row.source_refs_json, row.evidence_refs_json)) continue;
    const semantic = relationSemanticWeight(row.relation_type);
    const routeStrength = clamp01((
      Number(row.relation_relevance) * 0.45
      + Number(row.relation_confidence) * 0.35
      + authority * 0.2
    ) * semantic);
    if (routeStrength < MIN_ROUTE_STRENGTH) continue;
    const candidate: MemoryRelationRoutingCandidate = {
      seedAtomId: row.seed_atom_id,
      entry: rowToEntry(row),
      relationId: row.relation_id,
      relationType: row.relation_type,
      direction: row.seed_direction,
      relationConfidence: clamp01(Number(row.relation_confidence)),
      relationRelevance: clamp01(Number(row.relation_relevance)),
      routeStrength,
    };
    const current = selected.get(candidate.entry.atomId);
    if (!current || compareRoute(candidate, current) < 0) selected.set(candidate.entry.atomId, candidate);
  }
  return [...selected.values()]
    .sort(compareRoute)
    .slice(0, limit);
}

function relationAuthorityWeight(value: string, scope: string, scopeKey: string | null): number {
  try {
    const authority = JSON.parse(value) as { kind?: AuthorityKind; scope?: string; scopeKey?: string };
    if (authority.scope !== scope || (authority.scopeKey ?? '') !== (scopeKey ?? '')) return 0;
    const kind = authority.kind;
    if (kind === 'system-policy' || kind === 'tool-evidence') return 1;
    if (kind === 'user-self' || kind === 'project-owner' || kind === 'session-owner') return 0.9;
    if (kind === 'external-source') return 0.7;
    return 0;
  } catch {
    return 0;
  }
}

function hasTraceableRelationEvidence(sourceValue: string, evidenceValue: string): boolean {
  try {
    const sourceRefs = JSON.parse(sourceValue) as unknown;
    const evidenceRefs = JSON.parse(evidenceValue) as unknown;
    return (Array.isArray(sourceRefs) && sourceRefs.some((value) => typeof value === 'string' && value.trim()))
      || (Array.isArray(evidenceRefs) && evidenceRefs.some((value) => typeof value === 'string' && value.trim()));
  } catch {
    return false;
  }
}

function relationSemanticWeight(type: MemoryRelationType): number {
  if (type === 'depends-on' || type === 'supported-by' || type === 'replaces') return 1;
  if (type === 'conflicts-with') return 0.95;
  if (type === 'derived-from') return 0.85;
  if (type === 'belongs-to') return 0.8;
  if (type === 'affects') return 0.75;
  if (type === 'references') return 0.7;
  return 0;
}

function compareRoute(left: MemoryRelationRoutingCandidate, right: MemoryRelationRoutingCandidate): number {
  return right.routeStrength - left.routeStrength
    || right.relationRelevance - left.relationRelevance
    || right.relationConfidence - left.relationConfidence
    || right.entry.updatedAt.localeCompare(left.entry.updatedAt)
    || left.entry.atomId.localeCompare(right.entry.atomId)
    || left.relationId.localeCompare(right.relationId);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
