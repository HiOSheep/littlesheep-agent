// Scores scoped candidates and projects bounded D1-D3 evidence, relations, and audit history.

import type { MemoryScope } from '../types.js';
import type { MemoryAtomStore } from '../v3/atom-store.js';
import type { MemoryCatalog } from '../v3/catalog.js';
import type {
  MemoryAtom,
  MemoryAtomRetrievalPath,
  MemoryAtomHistory,
  MemoryCandidatePriorityBreakdown,
  MemoryDisclosureLevel,
  MemoryEvidenceEnvelope,
  MemoryRelation,
  MemoryRelationRouteEvidence,
  MemoryRelationNeighborhood,
} from '../v3/contracts.js';
import type { MemoryV3GraphStore } from '../v3/graph-store.js';
import { memoryRoutingRelevance, scoreMemoryCandidate } from '../v3/priority.js';
import { isMemoryV3InternalRootId } from './v3-node-mapping.js';
import type { MemoryV3RepositoryLedger } from './v3-ledger.js';
import type {
  MemoryRepositoryCandidate,
  MemoryRepositoryIndexRequest,
} from './retrieval.js';

const MAX_RELATIONS = 12;
const MAX_ENTITIES = 16;
const MAX_HISTORY = 16;
const MAX_EVIDENCE_REFS = 24;
const MAX_AUTHORITY_TOPICS = 16;
const DEEP_SEARCH_CLUSTER_MIN_TOP = 0.75;
const DEEP_SEARCH_CLUSTER_MIN_DROP = 0.06;

export interface MemoryV3ScoredCandidate {
  atom: MemoryAtom;
  relevance: number;
  retrievalPath: MemoryAtomRetrievalPath;
  matchReason: string;
  relationshipRelevanceHint?: number;
  relationRoute?: MemoryRelationRouteEvidence;
}

export class MemoryV3CandidateMaterializer {
  constructor(
    private readonly atomStore: MemoryAtomStore,
    private readonly catalog: MemoryCatalog,
    private readonly graphStore: MemoryV3GraphStore,
    private readonly ledger: MemoryV3RepositoryLedger,
  ) {}

  async materialize(
    pool: MemoryV3ScoredCandidate[],
    request: MemoryRepositoryIndexRequest,
    disclosureLevel: MemoryDisclosureLevel,
  ): Promise<MemoryRepositoryCandidate[]> {
    const deduped = new Map<string, MemoryV3ScoredCandidate>();
    for (const candidate of pool) {
      const current = deduped.get(candidate.atom.id);
      if (!current || candidate.relevance > current.relevance) deduped.set(candidate.atom.id, candidate);
    }
    const relationshipRelevance = this.catalog.relationRelevanceForAtoms([...deduped.keys()], request.now);
    const scored = [...deduped.values()].map((candidate) => ({
      candidate,
      priority: this.priority(
        candidate.atom,
        candidate.relevance,
        Math.max(
          relationshipRelevance.get(candidate.atom.id) ?? 0.5,
          candidate.relationshipRelevanceHint ?? 0.5,
        ),
        request.now,
      ),
    })).filter((entry) => entry.priority.eligible);
    scored.sort((left, right) => right.priority.score - left.priority.score
      || right.candidate.atom.updatedAt.localeCompare(left.candidate.atom.updatedAt)
      || left.candidate.atom.id.localeCompare(right.candidate.atom.id));

    const limit = Math.max(1, Math.min(request.limit, 100));
    const selected = isDeepSearchRequest(request)
      ? selectDeepSearchCluster(scored, limit)
      : scored.slice(0, limit);
    return Promise.all(selected.map(async ({ candidate, priority }) => {
      const conflict = isConflict(candidate.atom);
      const envelope = evidenceEnvelope(
        candidate,
        disclosureLevel,
        conflict,
        request.now,
        priority.taskRelevance,
        priority.routingRelevance,
        priority.relationshipRelevance,
        priority.activation,
      );
      const includeDetails = disclosureLevel === 'D2' || disclosureLevel === 'D3';
      return {
        atom: candidate.atom,
        envelope,
        priority,
        retrievalPath: candidate.retrievalPath,
        hasChildren: this.catalog.listChildrenByParent(candidate.atom.id)
          .some((entry) => !isMemoryV3InternalRootId(entry.atomId)),
        neighborhood: includeDetails ? await this.neighborhood(candidate.atom) : undefined,
        history: disclosureLevel === 'D3' ? this.history(candidate.atom) : undefined,
      };
    }));
  }

  /**
   * Governance and recovery must still inspect archived, disputed or
   * superseded Atoms even though ordinary retrieval correctly excludes them.
   */
  async inspectForManagement(
    atom: MemoryAtom,
    disclosureLevel: Extract<MemoryDisclosureLevel, 'D2' | 'D3'>,
    now: string,
  ): Promise<MemoryRepositoryCandidate> {
    const publicAtom = this.publicAtom(atom);
    const candidate: MemoryV3ScoredCandidate = {
      atom: publicAtom,
      relevance: 1,
      retrievalPath: 'hierarchy',
      matchReason: `Loaded atom ${atom.id} through the Runtime management boundary.`,
    };
    const relationshipRelevance = this.catalog.relationRelevanceForAtoms([atom.id], now).get(atom.id) ?? 0.5;
    const priority = this.priority(publicAtom, 1, relationshipRelevance, now);
    return {
      atom: publicAtom,
      envelope: evidenceEnvelope(
        candidate,
        disclosureLevel,
        isConflict(publicAtom),
        now,
        priority.taskRelevance,
        priority.routingRelevance,
        priority.relationshipRelevance,
        priority.activation,
      ),
      priority,
      retrievalPath: 'hierarchy',
      hasChildren: this.catalog.listChildrenByParent(atom.id)
        .some((entry) => !isMemoryV3InternalRootId(entry.atomId)),
      neighborhood: await this.neighborhood(atom),
      history: disclosureLevel === 'D3' ? this.history(atom) : undefined,
    };
  }

  publicAtom(atom: MemoryAtom): MemoryAtom {
    const scopeKey = this.ledger.publicScopeKey(atom.scope, atom.scopeKey);
    const authorityScope = atom.authorityScope.scope === atom.scope
      ? { ...atom.authorityScope, scopeKey }
      : atom.authorityScope;
    return { ...structuredClone(atom), scopeKey, authorityScope };
  }

  private priority(
    atom: MemoryAtom,
    taskRelevance: number,
    relationshipRelevance: number,
    now: string,
  ): MemoryCandidatePriorityBreakdown {
    const useful = atom.verifiedUsefulness.useful;
    const negative = atom.verifiedUsefulness.notUseful + atom.verifiedUsefulness.conflicts + atom.verifiedUsefulness.stale;
    const verifiedUsefulness = (useful + 1) / (useful + negative + 2);
    const topics = [...atom.authorityScope.topics, ...atom.retrievalKeys].map((value) => value.toLocaleLowerCase());
    const requiredByCurrentUser = atom.assertedBy.kind === 'user'
      && ['instruction', 'goal', 'preference', 'value', 'decision', 'approval'].includes(atom.statementKind)
      && taskRelevance >= 0.35;
    const safetyCritical = atom.authorityScope.kind === 'system-policy'
      && topics.some((value) => /safety|permission|security|安全|权限/u.test(value));
    return scoreMemoryCandidate({
      atom,
      now,
      scopeMatch: scopeWeight(atom.scope),
      taskRelevance,
      authorityMatch: authorityWeight(atom.authorityScope.kind),
      verifiedUsefulness,
      routingRelevance: memoryRoutingRelevance(atom, now),
      relationshipRelevance,
      decayHalfLifeDays: 45,
      requiredByCurrentUser,
      safetyCritical,
    });
  }

  private async neighborhood(atom: MemoryAtom): Promise<MemoryRelationNeighborhood | undefined> {
    const storageAtom = await this.atomStore.read(atom.id);
    if (!storageAtom || (storageAtom.relationRefs.length === 0 && storageAtom.entityRefs.length === 0)) return undefined;
    const relations: MemoryRelation[] = [];
    const entityIds = new Set(storageAtom.entityRefs);
    let truncated = false;
    for (const relationId of storageAtom.relationRefs) {
      if (relations.length >= MAX_RELATIONS) {
        truncated = true;
        break;
      }
      const relation = await this.graphStore.getRelation(relationId);
      if (!relation || ['archived', 'deleted'].includes(relation.status)) continue;
      if (relation.scope !== storageAtom.scope || (relation.scopeKey ?? '') !== (storageAtom.scopeKey ?? '')) continue;
      relations.push(this.publicRelation(relation));
      entityIds.add(relation.fromEntityId);
      entityIds.add(relation.toEntityId);
    }
    const entities = [];
    for (const entityId of entityIds) {
      if (entities.length >= MAX_ENTITIES) {
        truncated = true;
        break;
      }
      const entity = await this.graphStore.getEntity(entityId);
      if (!entity || entity.status !== 'active') continue;
      if (entity.scope !== storageAtom.scope || (entity.scopeKey ?? '') !== (storageAtom.scopeKey ?? '')) continue;
      entities.push({ ...entity, scopeKey: this.ledger.publicScopeKey(storageAtom.scope, entity.scopeKey) });
    }
    return { entities, relations, truncated };
  }

  private history(atom: MemoryAtom): MemoryAtomHistory {
    const entries = this.catalog.listAtomHistory(atom.id, MAX_HISTORY + 1);
    return {
      atomId: atom.id,
      revision: atom.revision,
      sourceRunIds: [...atom.sourceRunIds],
      sourceStages: [...atom.sourceStages],
      entries: entries.slice(0, MAX_HISTORY),
      truncated: entries.length > MAX_HISTORY,
    };
  }

  private publicRelation(relation: MemoryRelation): MemoryRelation {
    const scopeKey = this.ledger.publicScopeKey(relation.scope, relation.scopeKey);
    const authorityScope = relation.authorityScope.scope === relation.scope
      ? { ...relation.authorityScope, scopeKey }
      : relation.authorityScope;
    return { ...structuredClone(relation), scopeKey, authorityScope };
  }
}

function isDeepSearchRequest(request: MemoryRepositoryIndexRequest): boolean {
  return 'mode' in request && request.mode === 'deep-search';
}

export function selectDeepSearchCluster<T extends { priority: { taskRelevance: number } }>(
  scored: T[],
  limit: number,
): T[] {
  const baseline = scored.slice(0, limit);
  if (baseline.length < 2) return baseline;
  const byTask = [...scored]
    .sort((left, right) => right.priority.taskRelevance - left.priority.taskRelevance)
    .slice(0, limit);
  if (byTask[0]!.priority.taskRelevance < DEEP_SEARCH_CLUSTER_MIN_TOP) return baseline;
  let splitAfter = -1;
  let largestDrop = 0;
  for (let index = 0; index + 1 < byTask.length; index += 1) {
    const drop = byTask[index]!.priority.taskRelevance - byTask[index + 1]!.priority.taskRelevance;
    if (drop > largestDrop) {
      largestDrop = drop;
      splitAfter = index;
    }
  }
  if (splitAfter < 0 || largestDrop < DEEP_SEARCH_CLUSTER_MIN_DROP) return baseline;
  const floor = byTask[splitAfter]!.priority.taskRelevance;
  return scored.filter((entry) => entry.priority.taskRelevance >= floor).slice(0, limit);
}

function evidenceEnvelope(
  candidate: MemoryV3ScoredCandidate,
  disclosureLevel: MemoryDisclosureLevel,
  conflict: boolean,
  nowValue: string,
  taskRelevance: number,
  routingRelevance: number,
  relationshipRelevance: number,
  activation: MemoryEvidenceEnvelope['activation'],
): MemoryEvidenceEnvelope {
  const atom = candidate.atom;
  const now = Date.parse(nowValue);
  const expiresAt = atom.expiresAt ? Date.parse(atom.expiresAt) : Number.NaN;
  const expired = Number.isFinite(now) && Number.isFinite(expiresAt) && expiresAt <= now;
  return {
    atomId: atom.id,
    atomRevision: atom.revision,
    parentNodeId: atom.parentId && isMemoryV3InternalRootId(atom.parentId)
      ? `${atom.branch}:root`
      : atom.parentId,
    branch: atom.branch,
    scope: atom.scope,
    scopeKey: atom.scopeKey,
    tier: atom.tier,
    disclosureLevel,
    statementKind: atom.statementKind,
    epistemicStatus: atom.epistemicStatus,
    authorityScope: { ...structuredClone(atom.authorityScope), topics: atom.authorityScope.topics.slice(0, MAX_AUTHORITY_TOPICS) },
    assertedBy: structuredClone(atom.assertedBy),
    sourceRefs: atom.sourceRefs.slice(0, MAX_EVIDENCE_REFS),
    evidenceRefs: atom.evidenceRefs.slice(0, MAX_EVIDENCE_REFS),
    confidence: atom.confidence,
    importance: atom.importance,
    verifiedUsefulness: structuredClone(atom.verifiedUsefulness),
    taskRelevance,
    routingRelevance,
    relationshipRelevance,
    activation: structuredClone(activation),
    updatedAt: atom.updatedAt,
    lastVerifiedAt: atom.lastVerifiedAt,
    retrievalPath: candidate.retrievalPath,
    relationRoute: candidate.relationRoute ? structuredClone(candidate.relationRoute) : undefined,
    matchReason: candidate.matchReason,
    conflict: conflict || expired,
    expired,
    truncated: false,
  };
}

function authorityWeight(kind: MemoryAtom['authorityScope']['kind']): number {
  if (kind === 'system-policy' || kind === 'tool-evidence') return 1;
  if (kind === 'user-self' || kind === 'project-owner' || kind === 'session-owner') return 0.9;
  return kind === 'external-source' ? 0.65 : 0.3;
}

function scopeWeight(scope: MemoryScope): number {
  if (scope === 'session') return 1;
  if (scope === 'project') return 0.98;
  return scope === 'workspace' ? 0.92 : 0.8;
}

function isConflict(atom: MemoryAtom): boolean {
  return atom.epistemicStatus === 'disputed'
    || ['unresolved', 'under-review', 'rejected'].includes(atom.resolutionStatus)
    || atom.verifiedUsefulness.conflicts > 0;
}
