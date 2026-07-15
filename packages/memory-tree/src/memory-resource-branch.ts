import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  BranchDescription,
  BranchExpansion,
  BranchExpandRequest,
  BranchIndex,
  BranchSearchRequest,
  MemoryBranch,
  MemoryBranchContext,
  MemoryFragment,
  MemoryIndexEntry,
  MemoryResourceRegistration,
} from './types.js';
import { MemoryRepository } from './memory-repository.js';
import { estimateTokens } from './util.js';

const RESOURCE_BRANCH_ID = 'resources';

export interface MemoryResourceBranchOptions {
  repository: MemoryRepository;
  resolve?: MemoryResourceResolver;
}

export interface ResolvedMemoryResourceContent {
  content: string;
  source: string;
  generatedAt?: string;
}

export type MemoryResourceResolver = (
  resource: MemoryResourceRegistration,
  ctx: MemoryBranchContext,
) => Promise<ResolvedMemoryResourceContent | undefined>;

function normalizedPath(value: string): string {
  return resolve(value).replace(/[\\/]+/g, '/').replace(/\/$/u, '').toLocaleLowerCase();
}

function pathContains(root: string, target: string): boolean {
  const from = resolve(root);
  const to = resolve(target);
  const rel = relative(from, to);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isVisible(resource: MemoryResourceRegistration, ctx: MemoryBranchContext): boolean {
  if (resource.status !== 'active') return false;
  if (resource.scope === 'global') return true;
  if (resource.scope === 'session') return resource.scopeKey === String(ctx.sessionId);
  if (resource.scope === 'run') return resource.scopeKey === ctx.runId;
  if (!resource.scopeKey) return false;
  if (normalizedPath(resource.scopeKey) === normalizedPath(ctx.workspace)) return true;
  return pathContains(resource.scopeKey, ctx.workspace);
}

function queryScore(resource: MemoryResourceRegistration, query: string): number {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return 0.5;
  const terms = normalized.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
  if (terms.length === 0) return 0;
  const haystack = [
    resource.title,
    resource.description,
    resource.kind,
    resource.branch ?? '',
    resource.indexKeys.join(' '),
  ].join('\n').toLocaleLowerCase();
  const matched = terms.filter((term) => haystack.includes(term)).length;
  return matched / terms.length;
}

function toIndexEntry(resource: MemoryResourceRegistration): MemoryIndexEntry {
  return {
    id: resource.id,
    title: resource.title,
    summary: [
      resource.description,
      `T${resource.tier}; ${resource.scope}${resource.scopeKey ? `:${resource.scopeKey}` : ''}`,
      `authority=${resource.authority}; privacy=${resource.privacy}; source=${resource.source.kind}`,
    ].join('; '),
    hasChildren: true,
    searchKeys: resource.indexKeys.slice(0, 10),
    updatedAt: resource.updatedAt,
    metadata: {
      kind: resource.kind,
      tier: resource.tier,
      branch: resource.branch,
      scope: resource.scope,
      authority: resource.authority,
      privacy: resource.privacy,
      sourceKind: resource.source.kind,
    },
  };
}

function truncateToBudget(content: string, tokenBudget: number): { text: string; truncated: boolean } {
  const maxChars = Math.max(256, tokenBudget * 4);
  if (content.length <= maxChars) return { text: content, truncated: false };
  const marker = '\n\n... [resource body bounded; narrow the request or read the source file for more] ...\n\n';
  const available = Math.max(64, maxChars - marker.length);
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return {
    text: `${content.slice(0, head)}${marker}${content.slice(content.length - tail)}`,
    truncated: true,
  };
}

async function toFragment(
  resource: MemoryResourceRegistration,
  ctx: MemoryBranchContext,
  tokenBudget: number,
  matchReason: string,
  score: number,
  resolveResource?: MemoryResourceResolver,
): Promise<{ fragment: MemoryFragment; truncated: boolean }> {
  let raw: string;
  let resolvedSource = resource.source.path ?? resource.source.id ?? resource.id;
  let generatedAt = resource.updatedAt;
  if (resource.source.kind === 'file' && resource.source.path) {
    raw = await readFile(resource.source.path, 'utf8');
  } else {
    const resolved = await resolveResource?.(resource, ctx);
    if (!resolved) throw new Error(`Resource "${resource.id}" does not have an available content resolver.`);
    raw = resolved.content;
    resolvedSource = resolved.source;
    generatedAt = resolved.generatedAt ?? generatedAt;
  }
  const bounded = truncateToBudget(raw, tokenBudget);
  const content = [
    `## ${resource.title}`,
    bounded.text,
    '',
    `Resource authority: ${resource.authority}; privacy: ${resource.privacy}.`,
  ].join('\n');
  return {
    fragment: {
      id: resource.id,
      branchId: RESOURCE_BRANCH_ID,
      tier: resource.tier,
      priority: Math.max(0, Math.min(1, 0.55 + score * 0.35 - resource.tier * 0.05)),
      content,
      tokenEstimate: estimateTokens(content),
      truncatable: true,
      dedupKey: `memory-resource:${resource.id}:${resource.updatedAt}`,
      matchReason,
      metadata: {
        source: resolvedSource,
        kind: resource.kind,
        generatedAt,
        scope: resource.scope,
        scopeKey: resource.scopeKey,
        authority: resource.authority,
        privacy: resource.privacy,
        contentHash: resource.source.contentHash,
      },
    },
    truncated: bounded.truncated,
  };
}

export class MemoryResourceBranch implements MemoryBranch {
  readonly id = RESOURCE_BRANCH_ID;
  readonly kind = RESOURCE_BRANCH_ID;
  readonly displayName = 'Resource Directory';
  readonly purpose = 'Metadata-only catalog of authoritative Agent, user, tool, skill and project documents.';
  readonly whenToUse = 'the task depends on a registered rule, profile, skill, guideline, taskbook or knowledge document';
  readonly searchHints = ['AGENTS.md', 'SOUL.md', 'USER.md', 'PHILOSOPHY.md', 'TOOLS.md', 'skill', 'guideline', 'taskbook'];
  private readonly repository: MemoryRepository;
  private readonly resolveResource?: MemoryResourceResolver;

  constructor(options: MemoryResourceBranchOptions) {
    this.repository = options.repository;
    this.resolveResource = options.resolve;
  }

  describe(): BranchDescription {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      purpose: this.purpose,
      whenToUse: this.whenToUse,
      searchHints: [...this.searchHints],
      metadata: { registryVersion: 1, bodyPreloaded: false },
    };
  }

  async getIndex(ctx: MemoryBranchContext): Promise<BranchIndex> {
    const resources = (await this.repository.listResources({ status: 'active' })).filter((resource) => isVisible(resource, ctx));
    return {
      branchId: this.id,
      displayName: this.displayName,
      summary: `${resources.length} registered resource(s). Entries are metadata only; expand one resource to read its bounded body.`,
      entries: resources.slice(0, 100).map(toIndexEntry),
      generatedAt: ctx.now.toISOString(),
      source: this.repository.indexPath,
      truncated: resources.length > 100,
      nextCursor: resources.length > 100 ? '100' : undefined,
    };
  }

  async expand(ctx: MemoryBranchContext, request: BranchExpandRequest): Promise<BranchExpansion> {
    const visible = (await this.repository.listResources({ status: 'active' })).filter((resource) => isVisible(resource, ctx));
    let selected: Array<{ resource: MemoryResourceRegistration; score: number }> = [];
    let reason = 'Selected registered resource.';
    if (request.nodeId) {
      const resource = visible.find((entry) => entry.id === request.nodeId);
      if (resource) selected = [{ resource, score: 1 }];
      reason = `Selected registered resource ${request.nodeId}.`;
    } else if (request.query?.trim()) {
      selected = visible
        .map((resource) => ({ resource, score: queryScore(resource, request.query!) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.resource.tier - right.resource.tier)
        .slice(0, request.limit);
      reason = `Matched resource directory query: ${request.query}.`;
    } else {
      selected = visible
        .sort((left, right) => left.tier - right.tier || right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, request.limit)
        .map((resource) => ({ resource, score: 0.5 }));
    }

    const perResourceBudget = Math.max(64, Math.floor(request.tokenBudget / Math.max(1, selected.length)));
    const loaded = await Promise.all(selected.map(({ resource, score }) => (
      toFragment(resource, ctx, perResourceBudget, reason, score, this.resolveResource)
    )));
    return {
      branchId: this.id,
      nodeId: request.nodeId,
      query: request.query,
      fragments: loaded.map((entry) => entry.fragment),
      truncated: loaded.some((entry) => entry.truncated) || selected.length >= request.limit,
    };
  }

  async search(ctx: MemoryBranchContext, request: BranchSearchRequest): Promise<MemoryFragment[]> {
    const visible = (await this.repository.listResources({ status: 'active' })).filter((resource) => isVisible(resource, ctx));
    const selected = visible
      .map((resource) => ({ resource, score: queryScore(resource, request.query) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.resource.tier - right.resource.tier)
      .slice(0, request.limit);
    const perResourceBudget = Math.max(64, Math.floor(request.tokenBudget / Math.max(1, selected.length)));
    return Promise.all(selected.map(async ({ resource, score }) => (
      await toFragment(
        resource,
        ctx,
        perResourceBudget,
        `Branch-scoped resource search matched "${request.query}".`,
        score,
        this.resolveResource,
      )
    ).fragment));
  }
}
