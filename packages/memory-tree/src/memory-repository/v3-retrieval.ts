import { randomUUID } from 'node:crypto';
import type { MemoryAtomStore } from '../v3/atom-store.js';
import type { MemoryCatalog } from '../v3/catalog.js';
import type { MemoryAccessRecord, MemoryAtom } from '../v3/contracts.js';
import { EmbeddingUnavailableError } from '../v3/embedding-engine.js';
import type { MemoryV3GraphStore } from '../v3/graph-store.js';
import { isMemoryV3InternalRootId } from './v3-node-mapping.js';
import type { MemoryV3RepositoryLedger } from './v3-ledger.js';
import {
  MemoryV3CandidateMaterializer,
  type MemoryV3ScoredCandidate,
} from './v3-retrieval-materializer.js';
import type {
  MemoryRepositoryCandidate,
  MemoryRepositoryIndexRequest,
  MemoryRepositoryRetrievalBackend,
  MemoryRepositoryRetrievalRequest,
  MemoryRetrievalScope,
} from './retrieval.js';

const MAX_CANDIDATE_POOL = 400;

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
    const scopes = await this.resolveScopes(request.scopes);
    const pool: MemoryV3ScoredCandidate[] = [];
    for (const scope of scopes) {
      throwIfAborted(request.signal);
      const entries = request.parentNodeId
        ? this.catalog.listChildren(request.parentNodeId, {
            branch: request.branch,
            scope: scope.scope,
            scopeKey: scope.storageScopeKey,
          }).slice(0, MAX_CANDIDATE_POOL)
        : this.catalog.listAtoms({
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
        if (!atom) continue;
        pool.push({
          atom: this.materializer.publicAtom(atom),
          relevance: lexicalRelevance(atom, request.query),
          retrievalPath: 'hierarchy',
          matchReason: request.query.trim()
            ? `D1 branch index relevance for "${cleanInline(request.query)}".`
            : 'D1 branch index priority.',
        });
      }
    }
    return this.materializer.materialize(pool, request, 'D1');
  }

  async retrieveMemory(request: MemoryRepositoryRetrievalRequest): Promise<MemoryRepositoryCandidate[]> {
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
          relevance: 1,
          retrievalPath: 'hierarchy',
          matchReason: `Selected atom ${exact.id} through the indexed hierarchy.`,
        });
      }
    } else if (request.query.trim()) {
      pool = await this.searchScoped(request, scopes);
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
            relevance: lexicalRelevance(atom, request.query),
            retrievalPath: 'hierarchy',
            matchReason: 'Selected by scoped hierarchy priority.',
          });
        }
      }
    }
    return this.materializer.materialize(pool, request, request.disclosureLevel);
  }

  recordMemoryAccess(records: MemoryAccessRecord[]): void {
    this.catalog.recordAccessBatch(records
      .filter((record) => this.catalog.getAtom(record.atomId))
      .map((record) => ({ ...record, id: record.id || randomUUID() })));
  }

  private async searchScoped(
    request: MemoryRepositoryRetrievalRequest,
    scopes: ResolvedScope[],
  ): Promise<MemoryV3ScoredCandidate[]> {
    const merged = new Map<string, MemoryV3ScoredCandidate>();
    const perScopeLimit = Math.min(MAX_CANDIDATE_POOL, Math.max(request.limit * 4, 20));
    for (const scope of scopes) {
      const options = {
        branch: request.branch,
        scope: scope.scope,
        scopeKey: scope.storageScopeKey,
        subtreeRootId: request.subtreeRootId,
        limit: perScopeLimit,
      } as const;
      for (const result of this.catalog.searchFts(request.query, options)) {
        await this.mergeSearchResult(merged, result.entry.atomId, result.score, 'fts', request.query);
      }
      try {
        for (const result of await this.catalog.searchVector(request.query, options, request.signal)) {
          await this.mergeSearchResult(merged, result.entry.atomId, result.score, 'vector', request.query);
        }
      } catch (error) {
        if (!(error instanceof EmbeddingUnavailableError)) throw error;
        // A missing local model never blocks hierarchy or FTS retrieval.
      }
    }
    return [...merged.values()];
  }

  private async mergeSearchResult(
    merged: Map<string, MemoryV3ScoredCandidate>,
    atomId: string,
    score: number,
    path: Extract<MemoryAccessRecord['path'], 'fts' | 'vector'>,
    query: string,
  ): Promise<void> {
    if (isMemoryV3InternalRootId(atomId)) return;
    const atom = await this.atomStore.read(atomId);
    if (!atom) return;
    const relevance = clamp01(path === 'vector' ? (score + 1) / 2 : score);
    const current = merged.get(atomId);
    if (current && current.relevance >= relevance) return;
    merged.set(atomId, {
      atom: this.materializer.publicAtom(atom),
      relevance,
      retrievalPath: path,
      matchReason: `${path.toUpperCase()} matched "${cleanInline(query)}" inside the selected branch/subtree.`,
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

function lexicalRelevance(atom: MemoryAtom, query: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0.5;
  const haystack = `${atom.title}\n${atom.summary}\n${atom.content}\n${atom.retrievalKeys.join(' ')}`.toLocaleLowerCase();
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return clamp01(matches / terms.length * 0.85 + atom.importance * 0.1 + atom.confidence * 0.05);
}

function queryTerms(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const words = normalized.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
  const cjk = [...normalized].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char));
  for (let index = 0; index + 1 < cjk.length; index += 1) words.push(cjk[index]! + cjk[index + 1]!);
  return [...new Set(words)];
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
