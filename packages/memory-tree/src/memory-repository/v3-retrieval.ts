// Owns branch/scope-constrained Memory v3 retrieval and exact management inspection routing.

import { randomUUID } from 'node:crypto';
import type { MemoryAtomStore } from '../v3/atom-store.js';
import type { MemoryCatalog } from '../v3/catalog.js';
import type { MemoryAccessRecord, MemoryAtom, MemoryDisclosureLevel } from '../v3/contracts.js';
import { EmbeddingUnavailableError } from '../v3/embedding-engine.js';
import type { MemoryV3GraphStore } from '../v3/graph-store.js';
import {
  describeMemoryTaskRelevance,
  scoreMemoryTaskRelevance,
} from '../task-relevance.js';
import { composeMemoryTaskQuery, type MemoryTaskQuery } from '../task-query.js';
import { isMemoryV3InternalRootId } from './v3-node-mapping.js';
import type { MemoryV3RepositoryLedger } from './v3-ledger.js';
import {
  MemoryV3CandidateMaterializer,
  type MemoryV3ScoredCandidate,
} from './v3-retrieval-materializer.js';
import { addMemoryV3RelationCandidates } from './v3-retrieval-relations.js';
import { listActivationFallback } from './v3-retrieval-activation.js';
import type {
  MemoryRepositoryCandidate,
  MemoryRepositoryIndexRequest,
  MemoryRepositoryRetrievalBackend,
  MemoryRepositoryRetrievalRequest,
  MemoryRetrievalScope,
} from './retrieval.js';

const MAX_CANDIDATE_POOL = 400;
const D1_FALLBACK_POOL = 80;

interface ResolvedScope extends MemoryRetrievalScope {
  storageScopeKey?: string;
}

export interface MemoryV3RetrievalOptions {
  atomStore: MemoryAtomStore;
  catalog: MemoryCatalog;
  graphStore: MemoryV3GraphStore;
  ledger: MemoryV3RepositoryLedger;
}

/** Read-only Memory v3 retrieval path. Every content search remains branch/scope/subtree constrained. */
export class MemoryV3Retrieval implements MemoryRepositoryRetrievalBackend {
  private readonly atomStore: MemoryAtomStore;
  private readonly catalog: MemoryCatalog;
  private readonly ledger: MemoryV3RepositoryLedger;
  private readonly materializer: MemoryV3CandidateMaterializer;

  constructor(options: MemoryV3RetrievalOptions) {
    this.atomStore = options.atomStore;
    this.catalog = options.catalog;
    this.ledger = options.ledger;
    this.materializer = new MemoryV3CandidateMaterializer(
      options.atomStore,
      options.catalog,
      options.graphStore,
      options.ledger,
    );
  }

  async indexMemory(request: MemoryRepositoryIndexRequest): Promise<MemoryRepositoryCandidate[]> {
    const taskQuery = request.taskQuery ?? composeMemoryTaskQuery(request.query);
    const retrievalQuery = taskQuery.retrievalText || request.query;
    const scopes = await this.resolveScopes(request.scopes);
    const pool: MemoryV3ScoredCandidate[] = [];
    for (const scope of scopes) {
      throwIfAborted(request.signal);
      const entries = new Map<string, {
        entry: ReturnType<MemoryCatalog['listAtoms']>[number];
        retrievalPath: Extract<MemoryAccessRecord['path'], 'hierarchy' | 'fts'>;
      }>();
      if (!request.parentNodeId && retrievalQuery.trim()) {
        const ftsLimit = Math.min(200, Math.max(request.limit * 2, 40));
        for (const result of this.catalog.searchFts(retrievalQuery, {
          branch: request.branch,
          scope: scope.scope,
          scopeKey: scope.storageScopeKey,
          limit: ftsLimit,
        })) {
          entries.set(result.entry.atomId, { entry: result.entry, retrievalPath: 'fts' });
        }
      }
      const fallback = request.parentNodeId
        ? this.catalog.listChildren(request.parentNodeId, {
            branch: request.branch,
            scope: scope.scope,
            scopeKey: scope.storageScopeKey,
          }).slice(0, MAX_CANDIDATE_POOL)
        : listActivationFallback(
            this.catalog,
            request,
            scope,
            retrievalQuery.trim() ? D1_FALLBACK_POOL : MAX_CANDIDATE_POOL,
          );
      for (const entry of fallback) {
        if (!entries.has(entry.atomId)) entries.set(entry.atomId, { entry, retrievalPath: 'hierarchy' });
      }
      for (const { entry, retrievalPath } of entries.values()) {
        throwIfAborted(request.signal);
        if (isMemoryV3InternalRootId(entry.atomId)) continue;
        const atom = await this.atomStore.read(entry.atomId);
        if (!atom) continue;
        const relevance = taskRelevance(atom, taskQuery);
        if (relevance.blockedByExclusion) continue;
        pool.push({
          atom: this.materializer.publicAtom(atom),
          relevance: relevance.score,
          retrievalPath,
          matchReason: retrievalQuery.trim()
            ? `D1 ${retrievalPath} candidate for "${cleanInline(retrievalQuery)}": ${describeMemoryTaskRelevance(relevance)}.`
            : 'D1 branch index priority.',
        });
      }
    }
    const routed = await addMemoryV3RelationCandidates({
      pool, request, taskQuery, atomStore: this.atomStore, catalog: this.catalog,
      publicAtom: (atom) => this.materializer.publicAtom(atom),
    });
    return this.materializer.materialize(routed, request, 'D1');
  }

  async retrieveMemory(request: MemoryRepositoryRetrievalRequest): Promise<MemoryRepositoryCandidate[]> {
    const taskQuery = request.taskQuery ?? composeMemoryTaskQuery(request.query);
    const retrievalQuery = taskQuery.retrievalText || request.query;
    const scopes = await this.resolveScopes(request.scopes);
    throwIfAborted(request.signal);
    let pool: MemoryV3ScoredCandidate[] = [];
    if (request.nodeId) {
      const exact = await this.atomStore.read(request.nodeId);
      if (exact && !isMemoryV3InternalRootId(exact.id)
        && exact.branch === request.branch
        && this.scopeAllowed(exact, scopes)
        && await this.insideSubtree(exact, request.subtreeRootId)) {
        pool.push({
          atom: this.materializer.publicAtom(exact),
          relevance: retrievalQuery.trim() ? taskRelevance(exact, taskQuery).score : 1,
          retrievalPath: request.retrievalPathHint ?? 'hierarchy',
          matchReason: request.retrievalMatchReasonHint
            ?? `Selected atom ${exact.id} through the indexed hierarchy.`,
        });
      }
    } else if (retrievalQuery.trim()) {
      pool = await this.searchScoped(request, scopes, taskQuery);
    } else {
      for (const scope of scopes) {
        throwIfAborted(request.signal);
        const entries = this.catalog.listAtoms({
          branch: request.branch,
          scope: scope.scope,
          scopeKey: scope.storageScopeKey,
          status: 'active',
          limit: MAX_CANDIDATE_POOL,
        });
        for (const entry of entries) {
          throwIfAborted(request.signal);
          if (isMemoryV3InternalRootId(entry.atomId)) continue;
          const atom = await this.atomStore.read(entry.atomId);
          if (!atom || !await this.insideSubtree(atom, request.subtreeRootId)) continue;
          pool.push({
            atom: this.materializer.publicAtom(atom),
            relevance: taskRelevance(atom, taskQuery).score,
            retrievalPath: 'hierarchy',
            matchReason: 'Selected by scoped hierarchy priority.',
          });
        }
      }
    }
    const routed = request.nodeId ? pool : await addMemoryV3RelationCandidates({
      pool, request, taskQuery, atomStore: this.atomStore, catalog: this.catalog,
      publicAtom: (atom) => this.materializer.publicAtom(atom),
    });
    return this.materializer.materialize(routed, request, request.disclosureLevel);
  }

  recordMemoryAccess(records: MemoryAccessRecord[]): void {
    this.catalog.recordAccessBatch(records
      .filter((record) => this.catalog.getAtom(record.atomId))
      .map((record) => ({ ...record, id: record.id || randomUUID() })));
  }

  inspectAtomForManagement(
    atom: MemoryAtom,
    disclosureLevel: Extract<MemoryDisclosureLevel, 'D2' | 'D3'>,
    now: string,
  ): Promise<MemoryRepositoryCandidate> {
    return this.materializer.inspectForManagement(atom, disclosureLevel, now);
  }

  private async searchScoped(
    request: MemoryRepositoryRetrievalRequest,
    scopes: ResolvedScope[],
    taskQuery: MemoryTaskQuery,
  ): Promise<MemoryV3ScoredCandidate[]> {
    const retrievalQuery = taskQuery.retrievalText || request.query;
    const merged = new Map<string, MemoryV3ScoredCandidate>();
    const perScopeLimit = Math.min(MAX_CANDIDATE_POOL, Math.max(request.limit * 4, 20));
    // Only a deep search may fall back to vectors (RS-06A): an ordinary `expand` — including the
    // first one, which is where the query embedding used to be prepared — is answered by FTS, the
    // hierarchy and the relation edges alone. Preparing a query vector is itself a model call, and
    // paying it for navigation the reader did not ask for is exactly what the taskbook forbids.
    let preparedVector: Awaited<ReturnType<MemoryCatalog['prepareVectorQuery']>> | undefined;
    if (request.mode === 'deep-search') {
      try {
        preparedVector = await this.catalog.prepareVectorQuery(retrievalQuery, request.signal);
      } catch (error) {
        if (!(error instanceof EmbeddingUnavailableError)) throw error;
        // A missing local model never blocks hierarchy or FTS retrieval.
      }
    }
    for (const scope of scopes) {
      throwIfAborted(request.signal);
      const options = {
        branch: request.branch,
        scope: scope.scope,
        scopeKey: scope.storageScopeKey,
        subtreeRootId: request.subtreeRootId,
        limit: perScopeLimit,
      } as const;
      for (const result of this.catalog.searchFts(retrievalQuery, options)) {
        await this.mergeSearchResult(merged, result.entry.atomId, result.score, 'fts', taskQuery);
      }
      if (preparedVector) {
        for (const result of this.catalog.searchPreparedVector(preparedVector, options)) {
          await this.mergeSearchResult(merged, result.entry.atomId, result.score, 'vector', taskQuery);
        }
      }
    }
    return [...merged.values()];
  }

  private async mergeSearchResult(
    merged: Map<string, MemoryV3ScoredCandidate>,
    atomId: string,
    score: number,
    path: Extract<MemoryAccessRecord['path'], 'fts' | 'vector'>,
    taskQuery: MemoryTaskQuery,
  ): Promise<void> {
    if (isMemoryV3InternalRootId(atomId)) return;
    const atom = await this.atomStore.read(atomId);
    if (!atom) return;
    const lexical = taskRelevance(atom, taskQuery);
    if (lexical.blockedByExclusion) return;
    const relevance = clamp01(path === 'vector'
      ? Math.max((score + 1) / 2, lexical.score)
      : Math.max(score, lexical.score));
    const current = merged.get(atomId);
    if (current && current.relevance >= relevance) return;
    merged.set(atomId, {
      atom: this.materializer.publicAtom(atom),
      relevance,
      retrievalPath: path,
      matchReason: path === 'fts'
        ? `FTS matched "${cleanInline(taskQuery.retrievalText)}" inside the selected branch/subtree: ${describeMemoryTaskRelevance(lexical)}.`
        : `VECTOR matched "${cleanInline(taskQuery.retrievalText)}" inside the selected branch/subtree.`,
    });
  }

  private async resolveScopes(scopes: MemoryRetrievalScope[]): Promise<ResolvedScope[]> {
    const unique = new Map<string, MemoryRetrievalScope>();
    for (const scope of scopes) unique.set(`${scope.scope}:${scope.scopeKey ?? ''}`, scope);
    const resolved: ResolvedScope[] = [];
    for (const scope of unique.values()) {
      resolved.push({
        ...scope,
        storageScopeKey: await this.ledger.storageScopeKey(scope.scope, scope.scopeKey),
      });
    }
    return resolved;
  }

  private scopeAllowed(atom: MemoryAtom, scopes: ResolvedScope[]): boolean {
    return scopes.some((scope) => atom.scope === scope.scope
      && (atom.scopeKey ?? '') === (scope.storageScopeKey ?? ''));
  }

  private async insideSubtree(atom: MemoryAtom, subtreeRootId?: string): Promise<boolean> {
    if (!subtreeRootId) return true;
    let current: MemoryAtom | undefined = atom;
    for (let depth = 0; current && depth < 128; depth += 1) {
      if (current.id === subtreeRootId) return true;
      current = current.parentId ? await this.atomStore.read(current.parentId) : undefined;
    }
    return false;
  }

}

function taskRelevance(atom: MemoryAtom, query: string | MemoryTaskQuery) {
  return scoreMemoryTaskRelevance(query, {
    title: atom.title,
    summary: atom.summary,
    content: atom.content,
    searchKeys: atom.retrievalKeys,
  });
}

function cleanInline(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim().slice(0, 160);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Memory retrieval was aborted.');
  error.name = 'AbortError';
  throw error;
}
