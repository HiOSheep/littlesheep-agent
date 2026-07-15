// @littlesheep/memory-tree - branch adapter for indexed MemoryRepository nodes.

import type {
  BranchDescription,
  BranchExpansion,
  BranchExpandRequest,
  BranchIndex,
  BranchSearchRequest,
  MemoryBranch,
  MemoryBranchContext,
  MemoryBranchKind,
  MemoryFragment,
  MemoryIndexEntry,
  MemoryNode,
} from './types.js';
import { estimateTokens } from './util.js';
import { MemoryRepository } from './memory-repository.js';

export interface TreeMemoryBranchOptions {
  repository: MemoryRepository;
  kind: MemoryBranchKind;
  displayName: string;
  purpose: string;
  whenToUse: string;
  searchHints: string[];
}

function queryTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const words = normalized.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
  const cjk = [...normalized].filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char));
  for (let index = 0; index + 1 < cjk.length; index += 1) words.push(cjk[index]! + cjk[index + 1]!);
  return [...new Set(words)];
}

function relevance(node: MemoryNode, query: string): number {
  if (!query.trim()) return node.importance * 0.55 + node.confidence * 0.35 + 0.1;
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const haystack = `${node.summary}\n${node.content}\n${node.retrievalKeys.join(' ')}`.toLocaleLowerCase();
  const matches = terms.filter((term) => haystack.includes(term)).length;
  return Math.min(1, matches / terms.length * 0.7 + node.importance * 0.18 + node.confidence * 0.12);
}

function toIndexEntry(node: MemoryNode): MemoryIndexEntry {
  return {
    id: node.id,
    title: node.summary,
    summary: `${node.scope}${node.scopeKey ? `:${node.scopeKey}` : ''}; tier T${node.tier}; confidence ${node.confidence.toFixed(2)}`,
    hasChildren: node.childIds.length > 0,
    searchKeys: node.retrievalKeys.slice(0, 8),
    updatedAt: node.updatedAt,
    metadata: {
      tier: node.tier,
      scope: node.scope,
      scopeKey: node.scopeKey,
      importance: node.importance,
      confidence: node.confidence,
      reason: node.reason,
    },
  };
}

function toFragment(
  node: MemoryNode,
  branchId: string,
  reason: string,
  score: number,
  source: string,
): MemoryFragment {
  const content = [
    `## ${node.summary}`,
    node.content,
    '',
    `Source reason: ${node.reason}`,
  ].join('\n');
  return {
    id: node.id,
    branchId,
    parentNodeId: node.parentNodeId,
    tier: node.tier,
    priority: Math.max(0, Math.min(1, score)),
    content,
    tokenEstimate: estimateTokens(content),
    truncatable: true,
    dedupKey: `tree-node:${node.id}:${node.updatedAt}`,
    matchReason: reason,
    metadata: {
      source,
      kind: 'indexed-memory-node',
      generatedAt: node.updatedAt,
      runId: node.sourceRunIds.at(-1),
      sourceRunIds: node.sourceRunIds,
      sourceStages: node.sourceStages,
      scope: node.scope,
      scopeKey: node.scopeKey,
      confidence: node.confidence,
      importance: node.importance,
      writeReason: node.reason,
    },
  };
}

export class TreeMemoryBranch implements MemoryBranch {
  readonly id: MemoryBranchKind;
  readonly kind: MemoryBranchKind;
  readonly displayName: string;
  readonly purpose: string;
  readonly whenToUse: string;
  readonly searchHints: readonly string[];
  private readonly repository: MemoryRepository;

  constructor(options: TreeMemoryBranchOptions) {
    this.id = options.kind;
    this.kind = options.kind;
    this.displayName = options.displayName;
    this.purpose = options.purpose;
    this.whenToUse = options.whenToUse;
    this.searchHints = options.searchHints;
    this.repository = options.repository;
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
    const nodes = await this.repository.listNodes(this.kind, this.kind === 'project' ? ctx.workspace : undefined);
    return {
      branchId: this.id,
      displayName: this.displayName,
      summary: `${nodes.length} indexed ${this.kind} memories. Select a node or provide a query to expand only the relevant branch.`,
      entries: nodes.slice(0, 80).map(toIndexEntry),
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
    const nodes = await this.repository.listNodes(this.kind, this.kind === 'project' ? ctx.workspace : undefined);
    let selected: MemoryNode[];
    let matchReason: string;
    if (request.nodeId && request.nodeId !== MemoryRepository.branchRootId(this.kind)) {
      const node = await this.repository.getNode(request.nodeId);
      selected = node && node.branch === this.kind && node.status === 'active' ? [node] : [];
      matchReason = `Selected indexed node ${request.nodeId}.`;
    } else if (request.query?.trim()) {
      selected = nodes
        .map((node) => ({ node, score: relevance(node, request.query!) }))
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
      ? (await this.repository.children(request.nodeId)).map(toIndexEntry)
      : undefined;
    return {
      branchId: this.id,
      nodeId: request.nodeId,
      query: request.query,
      fragments: selected.map((node) => toFragment(
        node,
        this.id,
        matchReason,
        relevance(node, request.query ?? ''),
        this.repository.evidenceLocator(node.id),
      )),
      childIndex,
      truncated: selected.length >= request.limit || (childIndex?.length ?? 0) > request.limit,
    };
  }

  async search(ctx: MemoryBranchContext, request: BranchSearchRequest): Promise<MemoryFragment[]> {
    const nodes = await this.repository.listNodes(this.kind, this.kind === 'project' ? ctx.workspace : undefined);
    return nodes
      .map((node) => ({ node, score: relevance(node, request.query) }))
      .filter((entry) => entry.score > 0.15)
      .sort((left, right) => right.score - left.score)
      .slice(0, request.limit)
      .map(({ node, score }) => toFragment(
        node,
        this.id,
        `Deep search matched "${request.query}".`,
        score,
        this.repository.evidenceLocator(node.id),
      ));
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
