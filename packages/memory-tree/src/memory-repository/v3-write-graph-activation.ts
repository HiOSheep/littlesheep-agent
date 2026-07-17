// Activates committed relations and compensates an interrupted activation on startup.

import type { MemoryCatalog } from '../v3/catalog.js';
import type { MemoryAtom, MemoryRelation } from '../v3/contracts.js';
import type { MemoryV3GraphStore } from '../v3/graph-store.js';
import { isActivationEligible, sameScope } from './v3-write-graph-policy.js';

const MAX_RECONCILE_RELATIONS = 1_000;

export interface MemoryV3RelationProjectionRecovery {
  scanned: number;
  activated: number;
  skipped: number;
  truncated: boolean;
}

export async function activateMemoryRelationsForAtom(
  graphStore: MemoryV3GraphStore,
  catalog: MemoryCatalog,
  atom: MemoryAtom,
): Promise<string[]> {
  if (atom.status !== 'active') return [];
  const activated: string[] = [];
  for (const relationId of [...new Set(atom.relationRefs)].slice(0, 256)) {
    const relation = await graphStore.getRelation(relationId);
    if (!relation || relation.status !== 'proposed' || !isActivationEligible(relation)) continue;
    if (!sameScope(relation, atom.scope, atom.scopeKey)) continue;
    if (!catalog.relationReferenceBlockers(relation.id).atomIds.includes(atom.id)) continue;
    const updated = await activateRelation(graphStore, relation, atom.id, atom.updatedAt);
    catalog.audit('relation-activated', activationAudit(updated, atom.id), atom.id);
    activated.push(updated.id);
  }
  return activated;
}

export async function reconcileMemoryRelations(
  graphStore: MemoryV3GraphStore,
  catalog: MemoryCatalog,
  limit = MAX_RECONCILE_RELATIONS,
): Promise<MemoryV3RelationProjectionRecovery> {
  const requested = Number.isFinite(limit) ? Math.floor(limit) : MAX_RECONCILE_RELATIONS;
  const bounded = Math.max(1, Math.min(MAX_RECONCILE_RELATIONS, requested));
  const relations = await graphStore.listRelations({ status: 'proposed', limit: bounded + 1 });
  let activated = 0;
  let skipped = 0;
  for (const relation of relations.slice(0, bounded)) {
    if (!isActivationEligible(relation)) {
      skipped += 1;
      continue;
    }
    const atomId = catalog.relationReferenceBlockers(relation.id).atomIds.find((candidateId) => {
      const entry = catalog.getAtom(candidateId);
      return Boolean(entry
        && entry.status === 'active'
        && entry.epistemicStatus !== 'disputed'
        && entry.epistemicStatus !== 'superseded'
        && sameScope(relation, entry.scope, entry.scopeKey));
    });
    if (!atomId) {
      skipped += 1;
      continue;
    }
    const updated = await activateRelation(graphStore, relation, atomId, new Date().toISOString());
    catalog.audit('relation-activation-recovered', activationAudit(updated, atomId), atomId);
    activated += 1;
  }
  return {
    scanned: Math.min(relations.length, bounded),
    activated,
    skipped,
    truncated: relations.length > bounded,
  };
}

function activateRelation(
  graphStore: MemoryV3GraphStore,
  relation: MemoryRelation,
  _atomId: string,
  effectiveAt: string,
): Promise<MemoryRelation> {
  return graphStore.upsertRelation({
    ...relation,
    status: 'active',
    effectiveAt: relation.effectiveAt ?? effectiveAt,
    revision: relation.revision + 1,
    updatedAt: new Date().toISOString(),
  });
}

function activationAudit(relation: MemoryRelation, atomId: string): Record<string, unknown> {
  return {
    relationId: relation.id,
    relationType: relation.type,
    resolutionStatus: relation.resolutionStatus,
    sourceAtomId: atomId,
  };
}
