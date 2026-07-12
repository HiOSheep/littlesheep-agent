// @littlesheep/memory-tree - on-demand project index and git-memory branch.

import { normalize, resolve } from 'node:path';
import type {
  BranchDescription,
  BranchExpansion,
  BranchExpandRequest,
  BranchIndex,
  BranchSearchRequest,
  GitLogEntry,
  LogFn,
  MemoryBranch,
  MemoryBranchContext,
  MemoryFragment,
  ProjectEntry,
  ProjectIndex,
} from './types.js';
import { InjectionTier } from './types.js';
import { estimateTokens, activityScore } from './util.js';
import { fetchGitLog as defaultFetchGitLog } from './git-log.js';
import { readProjectIndex } from './project-index.js';

const DEFAULT_CACHE_TTL_MS = 300_000;
const DEFAULT_MAX_CACHE_ENTRIES = 50;
const DEFAULT_MAX_COMMITS = 10;

interface CacheEntry {
  entries: GitLogEntry[];
  fetchedAt: number;
}

export interface ProjectMemoryBranchDeps {
  dataDir: string;
  fetchGitLog?: (cwd: string, max: number, signal?: AbortSignal) => Promise<GitLogEntry[]>;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  maxCommitsPerProject?: number;
  log?: LogFn;
}

function projectNodeId(projectId: string): string {
  return `legacy-project:${encodeURIComponent(projectId)}`;
}

function decodeProjectNodeId(nodeId: string | undefined): string | undefined {
  const encoded = nodeId?.match(/^legacy-project:(.+)$/)?.[1];
  if (!encoded) return undefined;
  try { return decodeURIComponent(encoded); } catch { return undefined; }
}

function samePath(left: string, right: string): boolean {
  return normalize(resolve(left)).toLocaleLowerCase() === normalize(resolve(right)).toLocaleLowerCase();
}

export class ProjectMemoryBranch implements MemoryBranch {
  readonly id = 'project' as const;
  readonly kind = 'project' as const;
  readonly displayName = 'Project Memory';
  readonly purpose = 'Registered project paths and on-demand recent repository changes.';
  readonly whenToUse = 'the task depends on workspace history, repository identity or recent commits';
  readonly searchHints = ['workspace path', 'project id', 'git commit', 'recent change'] as const;

  private readonly deps: ProjectMemoryBranchDeps;
  private readonly fetchGitLogFn: (cwd: string, max: number, signal?: AbortSignal) => Promise<GitLogEntry[]>;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly maxCommitsPerProject: number;
  private readonly gitLogCache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<GitLogEntry[]>>();

  constructor(deps: ProjectMemoryBranchDeps) {
    this.deps = deps;
    this.fetchGitLogFn = deps.fetchGitLog ?? defaultFetchGitLog;
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxCacheEntries = deps.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.maxCommitsPerProject = deps.maxCommitsPerProject ?? DEFAULT_MAX_COMMITS;
  }

  describe(): BranchDescription {
    return {
      id: this.id,
      kind: this.kind,
      displayName: this.displayName,
      purpose: this.purpose,
      whenToUse: this.whenToUse,
      searchHints: [...this.searchHints],
      metadata: { source: 'projects/index.json' },
    };
  }

  async invalidate(): Promise<void> {
    this.gitLogCache.clear();
    this.inflight.clear();
  }

  async getIndex(ctx: MemoryBranchContext): Promise<BranchIndex> {
    const index = await this.readIndex();
    const projects = [...index.projects].sort((left, right) => {
      const leftCurrent = samePath(left.path, ctx.workspace) ? 1 : 0;
      const rightCurrent = samePath(right.path, ctx.workspace) ? 1 : 0;
      return rightCurrent - leftCurrent || right.lastActiveAt.localeCompare(left.lastActiveAt);
    });
    return {
      branchId: this.id,
      displayName: `${this.displayName} (registered projects)`,
      summary: `${projects.length} registered project(s). Git history is fetched only after a project/query is explicitly expanded.`,
      entries: projects.map((project) => {
        const days = Math.max(0, Math.floor((ctx.now.getTime() - new Date(project.lastActiveAt).getTime()) / 86_400_000));
        return {
          id: projectNodeId(project.id),
          title: project.id,
          summary: `${samePath(project.path, ctx.workspace) ? 'current workspace; ' : ''}${days === 0 ? 'active today' : `${days}d since activity`}`,
          hasChildren: true,
          searchKeys: [project.id, project.path],
          updatedAt: project.lastActiveAt,
          metadata: { path: project.path, currentWorkspace: samePath(project.path, ctx.workspace) },
        };
      }),
      generatedAt: ctx.now.toISOString(),
      source: this.indexPath(),
    };
  }

  async expand(ctx: MemoryBranchContext, request: BranchExpandRequest): Promise<BranchExpansion> {
    const index = await this.readIndex();
    const explicitId = decodeProjectNodeId(request.nodeId);
    const candidates = explicitId
      ? index.projects.filter((project) => project.id === explicitId)
      : this.matchProjects(index, ctx, request.query).slice(0, Math.max(1, Math.min(5, request.limit)));
    const fragments: MemoryFragment[] = [];
    for (const project of candidates) {
      const entries = await this.collectRecentChanges(project.path, ctx.signal);
      fragments.push(...entries.slice(0, request.limit).map((entry) => this.commitFragment(project, entry, request.query)));
    }
    this.evictIfOverLimit();
    return {
      branchId: this.id,
      nodeId: request.nodeId,
      query: request.query,
      fragments,
      truncated: fragments.length >= request.limit,
    };
  }

  async search(ctx: MemoryBranchContext, request: BranchSearchRequest): Promise<MemoryFragment[]> {
    const index = await this.readIndex();
    const projects = this.matchProjects(index, ctx, request.query).slice(0, 5);
    const needle = request.query.toLocaleLowerCase();
    const fragments: MemoryFragment[] = [];
    for (const project of projects) {
      const entries = await this.collectRecentChanges(project.path, ctx.signal);
      for (const entry of entries) {
        const haystack = `${project.id} ${project.path} ${entry.message} ${entry.hash}`.toLocaleLowerCase();
        if (haystack.includes(needle) || project.id.toLocaleLowerCase().includes(needle)) {
          fragments.push(this.commitFragment(project, entry, request.query));
        }
      }
    }
    this.evictIfOverLimit();
    return fragments.sort((left, right) => right.priority - left.priority).slice(0, request.limit);
  }

  private indexPath(): string {
    return `${this.deps.dataDir}/projects/index.json`;
  }

  private readIndex(): Promise<ProjectIndex> {
    return readProjectIndex(this.indexPath());
  }

  private matchProjects(index: ProjectIndex, ctx: MemoryBranchContext, query?: string): ProjectEntry[] {
    const needle = query?.trim().toLocaleLowerCase();
    return [...index.projects]
      .map((project) => {
        const current = samePath(project.path, ctx.workspace);
        const textual = !needle || `${project.id} ${project.path}`.toLocaleLowerCase().includes(needle);
        const activity = activityScore(new Date(project.lastActiveAt), ctx.now);
        return { project, score: (current ? 2 : 0) + (textual ? 1 : 0) + activity };
      })
      .filter((entry) => entry.score > 0.1)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.project);
  }

  private async collectRecentChanges(path: string, signal?: AbortSignal): Promise<GitLogEntry[]> {
    const existing = this.inflight.get(path);
    if (existing) return existing;
    const cached = this.gitLogCache.get(path);
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) return cached.entries;
    const promise = (async () => {
      try {
        const entries = await this.fetchGitLogFn(path, this.maxCommitsPerProject, signal);
        this.gitLogCache.set(path, { entries, fetchedAt: Date.now() });
        return entries;
      } catch (error) {
        this.deps.log?.('warn', `project-memory: git history failed for ${path}: ${(error as Error).message}`);
        return [];
      } finally {
        this.inflight.delete(path);
      }
    })();
    this.inflight.set(path, promise);
    return promise;
  }

  private commitFragment(project: ProjectEntry, entry: GitLogEntry, query?: string): MemoryFragment {
    const content = `- [${project.id}] ${entry.date}: ${entry.message} (${entry.hash})`;
    return {
      id: `git:${project.id}:${entry.hash}`,
      branchId: this.id,
      parentNodeId: projectNodeId(project.id),
      tier: InjectionTier.T2_RELEVANT,
      priority: activityScore(new Date(project.lastActiveAt), new Date()),
      content,
      tokenEstimate: estimateTokens(content),
      truncatable: true,
      dedupKey: `git:${project.path}:${entry.hash}`,
      matchReason: query ? `Project/git search matched "${query}".` : `Expanded project ${project.id}.`,
      metadata: {
        source: `git:${project.path}:${entry.hash}`,
        kind: 'git-commit',
        generatedAt: entry.date,
        project: project.id,
        projectPath: project.path,
        commit: entry.hash,
      },
    };
  }

  private evictIfOverLimit(): void {
    while (this.gitLogCache.size > this.maxCacheEntries) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, entry] of this.gitLogCache) {
        if (entry.fetchedAt < oldestTime) {
          oldestKey = key;
          oldestTime = entry.fetchedAt;
        }
      }
      if (!oldestKey) break;
      this.gitLogCache.delete(oldestKey);
    }
  }
}
