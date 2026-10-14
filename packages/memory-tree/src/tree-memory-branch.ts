// @littlesheep/memory-tree - branch adapter for indexed MemoryRepository nodes.

import { randomUUID } from 'node:crypto';
import { MemoryAccessAuthorizationError } from './memory-access-context.js';
import { assertAtomReadAuthorization, memoryNodeAccessRevision, type AtomReadAuthorization } from './atom-read-authorization.js';
import type {
  BranchDescription,
  BranchExpansion,
  BranchExpandRequest,
  BranchIndex,
  BranchSearchRequest,
  MemoryBranch,
  MemoryBranchAccessObservation,
  MemoryBranchContext,
  MemoryBranchKind,
  MemoryFragment,
  MemoryNode,
} from './types.js';
import { MemoryRepository } from './memory-repository.js';
import {
  legacyNodeFragment,
  legacyNodeIndexEntry,
  legacyNodeRelevance,
} from './tree-memory-legacy-presentation.js';
import {
  retrievalScopes,
  toV3Fragment,
  toV3IndexEntry,
} from './tree-memory-v3-presentation.js';
import { composeMemoryTaskQuery } from './task-query.js';

export interface TreeMemoryBranchOptions {
  authorization?: (runId: string) => Promise<AtomReadAuthorization | undefined>;
  repository: MemoryRepository;
  kind: MemoryBranchKind;
  displayName: string;
  purpose: string;
  whenToUse: string;
  searchHints: string[];
}

export class TreeMemoryBranch implements MemoryBranch {
  readonly id: MemoryBranchKind;
  readonly kind: MemoryBranchKind;
  readonly displayName: string;
  readonly purpose: string;
  readonly whenToUse: string;
  readonly searchHints: readonly string[];
  private readonly repository: MemoryRepository;
  private readonly authorization?: TreeMemoryBranchOptions['authorization'];

  constructor(options: TreeMemoryBranchOptions) {
    this.id = options.kind;
    this.kind = options.kind;
    this.displayName = options.displayName;
    this.purpose = options.purpose;
    this.whenToUse = options.whenToUse;
    this.searchHints = options.searchHints;
    this.repository = options.repository;
    this.authorization = options.authorization;
  }

  describe(): BranchDescription {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      purpose: this.purpose,
      whenToUse: this.whenToUse,
      searchHints: [...this.searchHints],
      metadata: { rootNodeId: MemoryRepository.branchRootId(this.kind) },
    };
  }

  async getIndex(ctx: MemoryBranchContext): Promise<BranchIndex> {
    return this.protectedRead(ctx, () => this.indexImpl(ctx));
  }

  private async indexImpl(ctx: MemoryBranchContext): Promise<BranchIndex> {
    const authorization = await this.authorization?.(ctx.runId);
    if (this.repository.retrieval.supported) {
      const taskQuery = ctx.taskQuery ?? composeMemoryTaskQuery(ctx.query);
      const candidates = await this.repository.retrieval.indexMemory({
        authorization,
        branch: this.kind,
        scopes: retrievalScopes(ctx),
        query: taskQuery.retrievalText || ctx.query,
        taskQuery,
        limit: 80,
        now: ctx.now.toISOString(),
        signal: ctx.signal,
      }) ?? [];
      return {
        branchId: this.id,
        displayName: this.displayName,
        summary: `${candidates.length} D1 atom summaries from the scoped Memory v3 Catalog. Expand only the atom or query needed by the current task.`,
        entries: candidates.map(toV3IndexEntry),
        generatedAt: ctx.now.toISOString(),
        source: this.repository.indexPath,
        truncated: candidates.length >= 80,
        nextCursor: candidates.length >= 80 ? '80' : undefined,
      };
    }
    const nodes = await this.nodes(ctx, authorization);
    return {
      branchId: this.id,
      displayName: this.displayName,
      summary: `${nodes.length} indexed ${this.kind} memories. Select a node or provide a query to expand only the relevant branch.`,
      entries: nodes.slice(0, 80).map(legacyNodeIndexEntry),
      generatedAt: ctx.now.toISOString(),
      source: this.repository.indexPath,
      truncated: nodes.length > 80,
      nextCursor: nodes.length > 80 ? '80' : undefined,
    };
  }

  async expand(
    ctx: MemoryBranchContext,
    request: BranchExpandRequest,
  ): Promise<BranchExpansion> {
    return this.protectedRead(ctx, () => this.expandImpl(ctx, request));
  }

  private async expandImpl(ctx: MemoryBranchContext, request: BranchExpandRequest): Promise<BranchExpansion> {
    const authorization = await this.authorization?.(ctx.runId);
    if (this.repository.retrieval.supported) {
      const taskQuery = request.taskQuery ?? composeMemoryTaskQuery(request.query ?? ctx.query);
      const disclosureLevel = request.disclosureLevel ?? 'D2';
      if (disclosureLevel === 'D3' && !request.nodeId) {
        throw new Error('Memory D3 disclosure requires one selected atom id; broad audit expansion is forbidden.');
      }
      const candidates = await this.repository.retrieval.retrieveMemory({
        authorization,
        branch: this.kind,
        scopes: retrievalScopes(ctx),
        query: taskQuery.retrievalText || request.query || '',
        taskQuery,
        nodeId: request.nodeId,
        limit: request.limit,
        now: ctx.now.toISOString(),
        signal: ctx.signal,
        disclosureLevel,
        mode: 'expand',
        retrievalPathHint: request.retrievalPathHint,
        retrievalMatchReasonHint: request.retrievalMatchReasonHint,
      }) ?? [];
      const childCandidates = request.nodeId
        ? await this.repository.retrieval.indexMemory({
            authorization,
            branch: this.kind,
            scopes: retrievalScopes(ctx),
            query: taskQuery.retrievalText || request.query || ctx.query,
            taskQuery,
            parentNodeId: request.nodeId,
            limit: request.limit,
            now: ctx.now.toISOString(),
            signal: ctx.signal,
          }) ?? []
        : [];
      return {
        branchId: this.id,
        nodeId: request.nodeId,
        query: request.query,
        fragments: candidates.map((candidate) => toV3Fragment(candidate, this.id)),
        childIndex: childCandidates.length > 0 ? childCandidates.map(toV3IndexEntry) : undefined,
        truncated: candidates.length >= request.limit || childCandidates.length >= request.limit,
      };
    }
    const nodes = await this.nodes(ctx, authorization);
    let selected: MemoryNode[];
    let matchReason: string;
    if (request.nodeId && request.nodeId !== MemoryRepository.branchRootId(this.kind)) {
      const node = authorization ? nodes.find((entry) => entry.id === request.nodeId) : await this.repository.getNode(request.nodeId);
      selected = node && node.branch === this.kind && node.status === 'active' ? [node] : [];
      matchReason = `Selected indexed node ${request.nodeId}.`;
    } else if (request.query?.trim()) {
      selected = nodes
        .map((node) => ({ node, score: legacyNodeRelevance(node, request.query!) }))
        .filter((entry) => entry.score > 0.15)
        .sort((left, right) => right.score - left.score)
        .slice(0, request.limit)
        .map((entry) => entry.node);
      matchReason = `Matched branch query: ${request.query}.`;
    } else {
      selected = nodes
        .sort((left, right) => right.importance - left.importance || right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, request.limit);
      matchReason = 'Selected highest-importance recent nodes from the requested branch.';
    }

    const childIndex = request.nodeId
      ? (authorization ? nodes.filter((node) => node.parentNodeId === request.nodeId) : await this.repository.children(request.nodeId)).map(legacyNodeIndexEntry)
      : undefined;
    return {
      branchId: this.id,
      nodeId: request.nodeId,
      query: request.query,
      fragments: selected.map((node) => legacyNodeFragment(
        node,
        this.id,
        matchReason,
        legacyNodeRelevance(node, request.query ?? ''),
        this.repository.evidenceLocator(node.id),
      )),
      childIndex,
      truncated: selected.length >= request.limit || (childIndex?.length ?? 0) > request.limit,
    };
  }

  async search(ctx: MemoryBranchContext, request: BranchSearchRequest): Promise<MemoryFragment[]> {
    return this.protectedRead(ctx, () => this.searchImpl(ctx, request));
  }

  private async searchImpl(ctx: MemoryBranchContext, request: BranchSearchRequest): Promise<MemoryFragment[]> {
    const authorization = await this.authorization?.(ctx.runId);
    if (this.repository.retrieval.supported) {
      const taskQuery = request.taskQuery ?? composeMemoryTaskQuery(request.query);
      const candidates = await this.repository.retrieval.retrieveMemory({
        authorization,
        branch: this.kind,
        scopes: retrievalScopes(ctx),
        query: taskQuery.retrievalText || request.query,
        taskQuery,
        subtreeRootId: request.subtreeRootId,
        limit: request.limit,
        now: ctx.now.toISOString(),
        signal: ctx.signal,
        disclosureLevel: 'D2',
        mode: 'deep-search',
      }) ?? [];
      return candidates.map((candidate) => toV3Fragment(candidate, this.id));
    }
    let nodes = await this.nodes(ctx, authorization);
    if (authorization && request.subtreeRootId && request.subtreeRootId !== MemoryRepository.branchRootId(this.kind)) {
      const byId = new Map(nodes.map((node) => [node.id, node]));
      nodes = nodes.filter((node) => {
        const seen = new Set<string>();
        let current: MemoryNode | undefined = node;
        while (current && !seen.has(current.id)) {
          if (current.id === request.subtreeRootId) return true;
          seen.add(current.id); current = current.parentNodeId ? byId.get(current.parentNodeId) : undefined;
        }
        return false;
      });
    }
    return nodes
      .map((node) => ({ node, score: legacyNodeRelevance(node, request.query) }))
      .filter((entry) => entry.score > 0.15)
      .sort((left, right) => right.score - left.score)
      .slice(0, request.limit)
      .map(({ node, score }) => legacyNodeFragment(
        node,
        this.id,
        `Deep search matched "${request.query}".`,
        score,
        this.repository.evidenceLocator(node.id),
      ));
  }

  recordAccess(ctx: MemoryBranchContext, observations: MemoryBranchAccessObservation[]): Promise<void> {
    return this.repository.retrieval.recordAccess(observations.map((observation) => ({
      id: randomUUID(),
      atomId: observation.atomId,
      runId: ctx.runId,
      stage: 'execute',
      path: observation.path,
      matchReason: observation.matchReason,
      enteredContext: observation.enteredContext,
      disclosureLevel: observation.disclosureLevel,
      tokensUsed: observation.tokensUsed,
      accessedAt: new Date().toISOString(),
    })));
  }

  private async nodes(ctx: MemoryBranchContext, gate?: AtomReadAuthorization): Promise<MemoryNode[]> {
    if (!gate) return this.repository.listNodes(this.kind, this.kind === 'project' ? ctx.workspace : undefined);
    const nodes: MemoryNode[] = [];
    for (const id of await gate.references()) {
      if (!await gate.allows(id)) continue;
      const node = await this.repository.getNode(id);
      if (!node || node.isBranchRoot || node.branch !== this.kind || node.status !== 'active'
        || !await gate.allows(id, memoryNodeAccessRevision(node))) continue;
      const again = await this.repository.getNode(id);
      if (!again || memoryNodeAccessRevision(again) !== memoryNodeAccessRevision(node)) continue;
      nodes.push(node);
    }
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]!;
      const current = await this.repository.getNode(node.id);
      if (!current || memoryNodeAccessRevision(current) !== memoryNodeAccessRevision(node)
        || !await gate.allows(node.id, memoryNodeAccessRevision(current))) nodes.splice(index, 1);
    }
    const ids = new Set(nodes.map((node) => node.id));
    const branchRootId = MemoryRepository.branchRootId(this.kind);
    await gate.assertCurrent();
    return nodes.map((node) => ({ ...node, childIds: node.childIds.filter((id) => ids.has(id)),
      // The branch root is a fixed navigation id, not an Atom body; keeping it lets the run reach the
      // authorized children of the root without widening the read to unbound Atoms.
      parentNodeId: node.parentNodeId && (ids.has(node.parentNodeId) || node.parentNodeId === branchRootId)
        ? node.parentNodeId : undefined,
      entityRefs: [], relationRefs: [] }));
  }

  private async protectedRead<T>(ctx: MemoryBranchContext, read: () => Promise<T>): Promise<T> {
    const gate = await this.authorization?.(ctx.runId);
    if (gate) assertAtomReadAuthorization(gate);
    try {
      const result = await read();
      await gate?.assertCurrent();
      return result;
    } catch (error) {
      if (gate) throw new MemoryAccessAuthorizationError('Memory authorization unavailable');
      throw error;
    }
  }
}

export const DEFAULT_BRANCH_SPECS: ReadonlyArray<Omit<TreeMemoryBranchOptions, 'repository'>> = [
  {
    kind: 'long-term',
    displayName: 'Long-term Memory',
    purpose: 'Stable cross-project facts, explicit user preferences and durable decisions.',
    whenToUse: 'the task depends on enduring user choices, identity, policy or prior decisions',
    searchHints: ['preference', 'decision', 'identity', 'long-term fact'],
  },
  {
    kind: 'daily',
    displayName: 'Daily Timeline',
    purpose: 'Detailed chronological run observations and recent events.',
    whenToUse: 'the user refers to what happened recently or a prior run detail',
    searchHints: ['date', 'recent action', 'previous run', 'timeline'],
  },
  {
    kind: 'project',
    displayName: 'Project Memory',
    purpose: 'Workspace-scoped architecture, rules, paths and project decisions.',
    whenToUse: 'working inside a project or reasoning about its established conventions',
    searchHints: ['workspace', 'repository', 'architecture', 'project rule'],
  },
  {
    kind: 'experience',
    displayName: 'Experience Library',
    purpose: 'Reusable methods, verified solutions, failures and tool-use patterns.',
    whenToUse: 'choosing how to solve a recurring problem or avoid an earlier failure',
    searchHints: ['method', 'workflow', 'pitfall', 'verified solution'],
  },
];
