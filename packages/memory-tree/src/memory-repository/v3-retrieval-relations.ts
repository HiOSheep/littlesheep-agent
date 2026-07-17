// Adds bounded one-hop relation candidates without weakening task, scope, evidence, or budget gates.

import type { MemoryAtomStore } from '../v3/atom-store.js';
import type { MemoryCatalog } from '../v3/catalog.js';
import type { MemoryAtom } from '../v3/contracts.js';
import {
  describeMemoryTaskRelevance,
  scoreMemoryTaskRelevance,
} from '../task-relevance.js';
import type { MemoryTaskQuery } from '../task-query.js';
import { isMemoryV3InternalRootId } from './v3-node-mapping.js';
import type { MemoryV3ScoredCandidate } from './v3-retrieval-materializer.js';
import type {
  MemoryRepositoryIndexRequest,
  MemoryRepositoryRetrievalRequest,
} from './retrieval.js';

const MAX_RELATION_SEEDS = 8;
const MAX_RELATION_CANDIDATES = 24;
const MIN_RELATION_SEED_RELEVANCE = 0.7;
const MIN_RELATION_CANDIDATE_RELEVANCE = 0.25;

export interface MemoryV3RelationCandidateOptions {
  pool: MemoryV3ScoredCandidate[];
  request: MemoryRepositoryIndexRequest | MemoryRepositoryRetrievalRequest;
  taskQuery: MemoryTaskQuery;
  atomStore: MemoryAtomStore;
  catalog: MemoryCatalog;
  publicAtom: (atom: MemoryAtom) => MemoryAtom;
}

export async function addMemoryV3RelationCandidates(
  options: MemoryV3RelationCandidateOptions,
): Promise<MemoryV3ScoredCandidate[]> {
  const merged = new Map<string, MemoryV3ScoredCandidate>();
  for (const candidate of options.pool) {
    const current = merged.get(candidate.atom.id);
    if (!current || candidate.relevance > current.relevance) merged.set(candidate.atom.id, candidate);
  }
  const seeds = [...merged.values()]
    .filter((candidate) => candidate.relevance >= MIN_RELATION_SEED_RELEVANCE)
    .sort((left, right) => right.relevance - left.relevance
      || right.atom.updatedAt.localeCompare(left.atom.updatedAt)
      || left.atom.id.localeCompare(right.atom.id))
    .slice(0, MAX_RELATION_SEEDS);
  if (seeds.length === 0) return [...merged.values()];

  const routes = options.catalog.listRelationRoutingCandidates(
    seeds.map((candidate) => candidate.atom.id),
    {
      branch: options.request.branch,
      subtreeRootId: 'subtreeRootId' in options.request ? options.request.subtreeRootId : undefined,
      limit: Math.min(MAX_RELATION_CANDIDATES, Math.max(options.request.limit * 3, 6)),
    },
    options.request.now,
  );
  for (const route of routes) {
    throwIfAborted(options.request.signal);
    const atom = await options.atomStore.read(route.entry.atomId);
    if (!atom || isMemoryV3InternalRootId(atom.id)) continue;
    const relevance = scoreMemoryTaskRelevance(options.taskQuery, {
      title: atom.title,
      summary: atom.summary,
      content: atom.content,
      searchKeys: atom.retrievalKeys,
    });
    if (relevance.blockedByExclusion || relevance.score <= MIN_RELATION_CANDIDATE_RELEVANCE) continue;
    const current = merged.get(atom.id);
    if (current) {
      current.relationshipRelevanceHint = Math.max(current.relationshipRelevanceHint ?? 0.5, route.routeStrength);
      continue;
    }
    merged.set(atom.id, {
      atom: options.publicAtom(atom),
      relevance: relevance.score,
      retrievalPath: 'relation',
      relationshipRelevanceHint: route.routeStrength,
      relationRoute: {
        seedAtomId: route.seedAtomId,
        relationId: route.relationId,
        relationType: route.relationType,
        direction: route.direction,
        confidence: route.relationConfidence,
        relevance: route.relationRelevance,
        strength: route.routeStrength,
      },
      matchReason: `RELATION ${route.relationType} (${route.direction}) from seed ${route.seedAtomId} via ${route.relationId}; route=${route.routeStrength.toFixed(3)}; ${describeMemoryTaskRelevance(relevance)}.`,
    });
  }
  return [...merged.values()];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Memory retrieval was aborted.');
  error.name = 'AbortError';
  throw error;
}
