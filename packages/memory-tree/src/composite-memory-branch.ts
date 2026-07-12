// @littlesheep/memory-tree - merge multiple physical sources behind one branch index.

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
} from './types.js';

export interface CompositeMemoryBranchOptions {
  id: MemoryBranchKind;
  displayName: string;
  purpose: string;
  whenToUse: string;
  searchHints: string[];
  sources: MemoryBranch[];
}

export class CompositeMemoryBranch implements MemoryBranch {
  readonly id: MemoryBranchKind;
  readonly kind: MemoryBranchKind;
  readonly displayName: string;
  readonly purpose: string;
  readonly whenToUse: string;
  readonly searchHints: readonly string[];
  private readonly sources: MemoryBranch[];

  constructor(options: CompositeMemoryBranchOptions) {
    this.id = options.id;
    this.kind = options.id;
    this.displayName = options.displayName;
    this.purpose = options.purpose;
    this.whenToUse = options.whenToUse;
    this.searchHints = options.searchHints;
    this.sources = options.sources;
  }

  describe(): BranchDescription {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      purpose: this.purpose,
      whenToUse: this.whenToUse,
      searchHints: [...this.searchHints],
      metadata: { sourceCount: this.sources.length },
    };
  }

  async getIndex(ctx: MemoryBranchContext): Promise<BranchIndex> {
    const settled = await Promise.allSettled(this.sources.map((source) => source.getIndex(ctx)));
    const indexes = settled
      .filter((entry): entry is PromiseFulfilledResult<BranchIndex> => entry.status === 'fulfilled')
      .map((entry) => entry.value);
    const seen = new Set<string>();
    const entries = indexes.flatMap((index) => index.entries).filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
    const failures = settled.filter((entry) => entry.status === 'rejected').length;
    return {
      branchId: this.id,
      displayName: this.displayName,
      summary: `${entries.length} index entries across ${indexes.length} available source(s).${failures ? ` ${failures} source(s) degraded.` : ''}`,
      entries,
      generatedAt: ctx.now.toISOString(),
      source: indexes.map((index) => index.source).join('; '),
      truncated: indexes.some((index) => index.truncated),
      nextCursor: indexes.find((index) => index.nextCursor)?.nextCursor,
    };
  }

  async expand(ctx: MemoryBranchContext, request: BranchExpandRequest): Promise<BranchExpansion> {
    const settled = await Promise.allSettled(this.sources.map((source) => source.expand(ctx, request)));
    const expansions = settled
      .filter((entry): entry is PromiseFulfilledResult<BranchExpansion> => entry.status === 'fulfilled')
      .map((entry) => entry.value);
    return {
      branchId: this.id,
      nodeId: request.nodeId,
      query: request.query,
      fragments: this.uniqueFragments(expansions.flatMap((entry) => entry.fragments)),
      childIndex: expansions.flatMap((entry) => entry.childIndex ?? []),
      truncated: expansions.some((entry) => entry.truncated),
      nextCursor: expansions.find((entry) => entry.nextCursor)?.nextCursor,
    };
  }

  async search(ctx: MemoryBranchContext, request: BranchSearchRequest): Promise<MemoryFragment[]> {
    const settled = await Promise.allSettled(this.sources.map((source) => source.search(ctx, request)));
    return this.uniqueFragments(
      settled
        .filter((entry): entry is PromiseFulfilledResult<MemoryFragment[]> => entry.status === 'fulfilled')
        .flatMap((entry) => entry.value),
    ).sort((left, right) => right.priority - left.priority).slice(0, request.limit);
  }

  async invalidate(): Promise<void> {
    await Promise.allSettled(this.sources.map((source) => source.invalidate?.()));
  }

  private uniqueFragments(fragments: MemoryFragment[]): MemoryFragment[] {
    const seen = new Set<string>();
    return fragments.filter((fragment) => {
      if (seen.has(fragment.dedupKey)) return false;
      seen.add(fragment.dedupKey);
      return true;
    });
  }
}
