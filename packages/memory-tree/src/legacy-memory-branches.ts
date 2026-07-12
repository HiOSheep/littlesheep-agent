// @littlesheep/memory-tree - read-only adapters for existing user data.

import { createHash } from 'node:crypto';
import type { MemoryStoreLike } from '@littlesheep/types';
import type {
  BranchExpansion,
  BranchExpandRequest,
  BranchIndex,
  BranchSearchRequest,
  InjectionTier as InjectionTierType,
  MemoryBranch,
  MemoryBranchContext,
  MemoryFragment,
  MemoryIndexEntry,
  MemoryMigrationRecord,
  MemoryWriteIntent,
} from './types.js';
import { InjectionTier } from './types.js';
import { estimateTokens } from './util.js';
import { MemoryRepository } from './memory-repository.js';

interface LegacyRecord {
  id: string;
  title: string;
  content: string;
  source: string;
  kind: string;
  generatedAt: string;
  tier: InjectionTierType;
  confidence?: number;
  tags?: string[];
  runId?: string;
}

interface ExperienceEntryLike {
  id: string;
  category: string;
  content: string;
  confidence: number;
  source: string;
  tags: string[];
  createdAt: string;
  runId?: string;
}

export interface ExperienceStoreLike {
  list(query?: { limit?: number }): Promise<ExperienceEntryLike[]>;
  search(query: string, limit?: number): Promise<ExperienceEntryLike[]>;
}

export const LEGACY_MEMORY_MIGRATION_ID = 'legacy-user-data-v1';

export interface LegacyMemoryMigrationOptions {
  repository: MemoryRepository;
  memoryStore: MemoryStoreLike;
  experienceStore: ExperienceStoreLike;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface LegacyMemoryMigrationResult extends MemoryMigrationRecord {
  completed: boolean;
  alreadyCompleted: boolean;
  queued: number;
}

interface VectorSearchResultLike {
  id: string;
  text: string;
  tier: string;
  date: string;
  source: string;
  score: number;
}

export interface VectorMemorySearchLike {
  search(query: string, limit?: number, filter?: { tiers?: string[] }): Promise<VectorSearchResultLike[]>;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function terms(value: string): string[] {
  return value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
}

function score(record: LegacyRecord, query: string): number {
  if (!query.trim()) return 0.4;
  const needle = terms(query);
  if (needle.length === 0) return 0;
  const haystack = `${record.title}\n${record.content}\n${record.tags?.join(' ') ?? ''}`.toLocaleLowerCase();
  return Math.min(1, needle.filter((term) => haystack.includes(term)).length / needle.length);
}

function indexEntry(record: LegacyRecord): MemoryIndexEntry {
  return {
    id: record.id,
    title: record.title,
    summary: record.content.replace(/\s+/g, ' ').slice(0, 180),
    hasChildren: false,
    searchKeys: record.tags?.slice(0, 8),
    updatedAt: record.generatedAt,
    metadata: { source: record.source, kind: record.kind, confidence: record.confidence },
  };
}

function fragment(record: LegacyRecord, branchId: string, reason: string, priority: number): MemoryFragment {
  const content = `## ${record.title}\n${record.content}`;
  return {
    id: record.id,
    branchId,
    tier: record.tier,
    priority,
    content,
    tokenEstimate: estimateTokens(content),
    truncatable: true,
    dedupKey: `legacy:${record.source}:${record.id}`,
    matchReason: reason,
    metadata: {
      source: record.source,
      kind: record.kind,
      generatedAt: record.generatedAt,
      runId: record.runId,
      confidence: record.confidence,
      tags: record.tags,
      legacy: true,
    },
  };
}

function parseLongTerm(raw: string, source: string): LegacyRecord[] {
  const records: LegacyRecord[] = [];
  let heading = 'Legacy long-term memory';
  let lines: string[] = [];
  const flush = () => {
    const content = lines.join('\n').trim();
    if (!content) return;
    records.push({
      id: stableId('legacy-long-term', `${heading}\n${content}`),
      title: heading,
      content,
      source,
      kind: 'legacy-long-term-file',
      generatedAt: /^\d{4}-\d{2}-\d{2}T/.test(heading) ? heading : new Date(0).toISOString(),
      tier: InjectionTier.T2_RELEVANT,
    });
  };
  for (const line of raw.split('\n')) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      flush();
      heading = match[1]!;
      lines = [];
    } else if (line.trim() && !/^#\s/.test(line)) {
      lines.push(line.replace(/^[-*]\s+/, ''));
    }
  }
  flush();
  return records;
}

function dailyRecords(date: string, raw: string, source: string): LegacyRecord[] {
  const bodies = raw
    .split(/\n(?=-\s)/g)
    .map((line) => line.replace(/^#.*\n*/g, '').replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
  if (bodies.length === 0 && raw.trim()) bodies.push(raw.trim());
  return bodies.map((content, index) => ({
    id: stableId('legacy-daily', `${date}:${index}:${content}`),
    title: `${date} record ${index + 1}`,
    content,
    source,
    kind: 'legacy-daily-file',
    generatedAt: `${date}T00:00:00.000Z`,
    tier: InjectionTier.T3_DETAIL,
  }));
}

abstract class LegacyBranchBase implements MemoryBranch {
  abstract readonly id: 'long-term' | 'daily' | 'experience';
  abstract readonly kind: 'long-term' | 'daily' | 'experience';
  abstract readonly displayName: string;
  abstract readonly purpose: string;
  abstract readonly whenToUse: string;
  abstract readonly searchHints: readonly string[];
  protected abstract records(ctx: MemoryBranchContext): Promise<LegacyRecord[]>;

  async getIndex(ctx: MemoryBranchContext): Promise<BranchIndex> {
    const records = await this.records(ctx);
    return {
      branchId: this.id,
      displayName: `${this.displayName} (legacy source)`,
      summary: `${records.length} existing user-data record(s), exposed only through this branch index.`,
      entries: records.slice(0, 80).map(indexEntry),
      generatedAt: ctx.now.toISOString(),
      source: 'legacy-user-data',
      truncated: records.length > 80,
      nextCursor: records.length > 80 ? '80' : undefined,
    };
  }

  async expand(ctx: MemoryBranchContext, request: BranchExpandRequest): Promise<BranchExpansion> {
    const records = await this.records(ctx);
    const selected = request.nodeId
      ? records.filter((record) => record.id === request.nodeId)
      : request.query?.trim()
        ? records.map((record) => ({ record, score: score(record, request.query!) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score)
            .slice(0, request.limit)
            .map((entry) => entry.record)
        : records.slice(0, request.limit);
    return {
      branchId: this.id,
      nodeId: request.nodeId,
      query: request.query,
      fragments: selected.map((record) => fragment(
        record,
        this.id,
        request.nodeId ? `Selected legacy index node ${request.nodeId}.` : `Legacy source matched "${request.query ?? 'recent'}".`,
        score(record, request.query ?? ''),
      )),
      truncated: selected.length >= request.limit,
    };
  }

  async search(ctx: MemoryBranchContext, request: BranchSearchRequest): Promise<MemoryFragment[]> {
    return (await this.records(ctx))
      .map((record) => ({ record, score: score(record, request.query) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, request.limit)
      .map(({ record, score: priority }) => fragment(record, this.id, `Deep search matched "${request.query}".`, priority));
  }
}

export class LegacyLongTermBranch extends LegacyBranchBase {
  readonly id = 'long-term' as const;
  readonly kind = 'long-term' as const;
  readonly displayName = 'Long-term Memory';
  readonly purpose = 'Existing MEMORY.md records.';
  readonly whenToUse = 'a durable preference or decision may predate the indexed tree';
  readonly searchHints = ['MEMORY.md', 'legacy decision'];

  constructor(private readonly store: MemoryStoreLike) { super(); }

  protected async records(): Promise<LegacyRecord[]> {
    return parseLongTerm(await this.store.readLongTerm(), this.store.longTermPath);
  }
}

export class LegacyDailyBranch extends LegacyBranchBase {
  readonly id = 'daily' as const;
  readonly kind = 'daily' as const;
  readonly displayName = 'Daily Timeline';
  readonly purpose = 'Existing dated memory files.';
  readonly whenToUse = 'a prior run detail may live in the daily archive';
  readonly searchHints = ['date', 'daily file', 'recent run'];

  constructor(private readonly store: MemoryStoreLike) { super(); }

  override async getIndex(ctx: MemoryBranchContext): Promise<BranchIndex> {
    const dates = (await this.store.listDailyDates()).sort().reverse();
    return {
      branchId: this.id,
      displayName: `${this.displayName} (legacy source)`,
      summary: `${dates.length} dated files. Expand a date or deep-search a detail; none are preloaded.`,
      entries: dates.slice(0, 120).map((date) => ({
        id: `legacy-daily-date:${date}`,
        title: date,
        summary: 'Daily run details',
        hasChildren: true,
        updatedAt: `${date}T00:00:00.000Z`,
        metadata: { source: this.store.dailyFile(date) },
      })),
      generatedAt: ctx.now.toISOString(),
      source: this.store.dailyDirPath,
      truncated: dates.length > 120,
    };
  }

  protected async records(): Promise<LegacyRecord[]> {
    const dates = (await this.store.listDailyDates()).sort().reverse();
    const records: LegacyRecord[] = [];
    for (const date of dates) {
      const raw = await this.store.readDaily(date);
      records.push(...dailyRecords(date, raw, this.store.dailyFile(date)));
    }
    return records;
  }

  override async expand(ctx: MemoryBranchContext, request: BranchExpandRequest): Promise<BranchExpansion> {
    const date = request.nodeId?.match(/^legacy-daily-date:(\d{4}-\d{2}-\d{2})$/)?.[1];
    if (!date) return super.expand(ctx, request);
    const records = dailyRecords(date, await this.store.readDaily(date), this.store.dailyFile(date));
    return {
      branchId: this.id,
      nodeId: request.nodeId,
      query: request.query,
      fragments: records.slice(0, request.limit).map((record) => fragment(record, this.id, `Expanded daily index ${date}.`, 0.65)),
      truncated: records.length > request.limit,
    };
  }
}

export class LegacyExperienceBranch extends LegacyBranchBase {
  readonly id = 'experience' as const;
  readonly kind = 'experience' as const;
  readonly displayName = 'Experience Library';
  readonly purpose = 'Existing structured experience database.';
  readonly whenToUse = 'a reusable lesson may predate the indexed tree';
  readonly searchHints = ['experience', 'evolution', 'lesson'];

  constructor(private readonly store: ExperienceStoreLike) { super(); }

  protected async records(): Promise<LegacyRecord[]> {
    return (await this.store.list()).map((entry) => ({
      id: `legacy-experience:${entry.id}`,
      title: `[${entry.category}] ${entry.content.replace(/\s+/g, ' ').slice(0, 80)}`,
      content: entry.content,
      source: `experience:${entry.id}`,
      kind: 'legacy-experience-record',
      generatedAt: entry.createdAt,
      tier: entry.confidence >= 0.7 ? InjectionTier.T2_RELEVANT : InjectionTier.T3_DETAIL,
      confidence: entry.confidence,
      tags: entry.tags,
      runId: entry.runId,
    }));
  }

  override async search(_ctx: MemoryBranchContext, request: BranchSearchRequest): Promise<MemoryFragment[]> {
    return (await this.store.search(request.query, request.limit)).map((entry) => {
      const record: LegacyRecord = {
        id: `legacy-experience:${entry.id}`,
        title: `[${entry.category}] ${entry.content.replace(/\s+/g, ' ').slice(0, 80)}`,
        content: entry.content,
        source: `experience:${entry.id}`,
        kind: 'legacy-experience-record',
        generatedAt: entry.createdAt,
        tier: entry.confidence >= 0.7 ? InjectionTier.T2_RELEVANT : InjectionTier.T3_DETAIL,
        confidence: entry.confidence,
        tags: entry.tags,
        runId: entry.runId,
      };
      return fragment(record, this.id, `Experience search matched "${request.query}".`, entry.confidence);
    });
  }
}

function migrationSummary(record: LegacyRecord): string {
  const titleIsTimestamp = /^\d{4}-\d{2}-\d{2}T/.test(record.title);
  const value = titleIsTimestamp
    ? record.content.split(/\r?\n/, 1)[0] ?? record.title
    : record.title;
  return value.replace(/^[-*#\s]+/, '').replace(/\s+/g, ' ').slice(0, 220) || 'Imported memory';
}

function migrationIntent(branch: 'long-term' | 'daily' | 'experience', record: LegacyRecord): MemoryWriteIntent {
  const confidence = branch === 'long-term'
    ? 0.82
    : branch === 'experience'
      ? Math.max(0.7, record.confidence ?? 0.7)
      : 0.65;
  const importance = branch === 'long-term' ? 0.8 : branch === 'experience' ? 0.68 : 0.45;
  return {
    id: `migration:${LEGACY_MEMORY_MIGRATION_ID}:${record.id}`,
    branch,
    parentNodeId: MemoryRepository.branchRootId(branch),
    scope: 'global',
    tier: record.tier,
    summary: migrationSummary(record),
    content: record.content,
    retrievalKeys: [...new Set([
      branch,
      record.kind,
      ...(record.tags ?? []),
      ...terms(`${record.title} ${record.content}`).slice(0, 16),
    ])].slice(0, 24),
    sourceRunId: record.runId ?? record.id,
    sourceStage: 'migration',
    sourceRefs: [record.source],
    importance,
    confidence,
    reason: `Migrated from the pre-index memory source ${record.source}; the original source remains unchanged.`,
    createdAt: record.generatedAt,
  };
}

/**
 * Copies legacy user-memory sources into the indexed repository once. The
 * original files remain untouched; callers can stop registering legacy read
 * adapters after this returns completed=true, avoiding duplicate injection.
 */
export async function migrateLegacyMemorySources(
  options: LegacyMemoryMigrationOptions,
): Promise<LegacyMemoryMigrationResult> {
  const previous = await options.repository.getMigration(LEGACY_MEMORY_MIGRATION_ID);
  if (previous) {
    return { ...previous, completed: true, alreadyCompleted: true, queued: 0 };
  }

  const records: Array<{ branch: 'long-term' | 'daily' | 'experience'; record: LegacyRecord }> = [];
  records.push(...parseLongTerm(
    await options.memoryStore.readLongTerm(),
    options.memoryStore.longTermPath,
  ).map((record) => ({ branch: 'long-term' as const, record })));

  for (const date of (await options.memoryStore.listDailyDates()).sort()) {
    const daily = dailyRecords(
      date,
      await options.memoryStore.readDaily(date),
      options.memoryStore.dailyFile(date),
    );
    records.push(...daily.map((record) => ({ branch: 'daily' as const, record })));
  }

  const experiences = await options.experienceStore.list();
  records.push(...experiences.map((entry) => ({
    branch: 'experience' as const,
    record: {
      id: `legacy-experience:${entry.id}`,
      title: `[${entry.category}] ${entry.content.replace(/\s+/g, ' ').slice(0, 80)}`,
      content: entry.content,
      source: `experience:${entry.id}`,
      kind: 'legacy-experience-record',
      generatedAt: entry.createdAt,
      tier: entry.confidence >= 0.7 ? InjectionTier.T2_RELEVANT : InjectionTier.T3_DETAIL,
      confidence: entry.confidence,
      tags: entry.tags,
      runId: entry.runId,
    },
  })));

  const counts = { created: 0, merged: 0, reinforced: 0, rejected: 0, queued: 0 };
  for (const item of records) {
    const result = await options.repository.write(migrationIntent(item.branch, item.record));
    counts[result.decision] += 1;
  }

  const completed = counts.queued === 0;
  const record: MemoryMigrationRecord = {
    id: LEGACY_MEMORY_MIGRATION_ID,
    completedAt: new Date().toISOString(),
    sourceCount: records.length,
    created: counts.created,
    merged: counts.merged,
    reinforced: counts.reinforced,
    rejected: counts.rejected,
  };
  if (completed) await options.repository.markMigration(record);
  options.log?.(
    completed ? 'info' : 'warn',
    `memory-tree: legacy migration ${completed ? 'completed' : 'left queued writes'} (${records.length} source records)`,
    counts,
  );
  return { ...record, completed, alreadyCompleted: false, queued: counts.queued };
}

/** Semantic recall remains a lower source of the daily branch, not a parallel untracked tool. */
export class SemanticDailyBranch implements MemoryBranch {
  readonly id = 'daily' as const;
  readonly kind = 'daily' as const;
  readonly displayName = 'Daily Semantic Index';
  readonly purpose = 'Vector-ranked daily and distilled memory records.';
  readonly whenToUse = 'keyword indexes are insufficient but the task has a clear semantic query';
  readonly searchHints = ['semantic similarity', 'paraphrase', 'distilled memory'] as const;

  constructor(private readonly store: VectorMemorySearchLike) {}

  async getIndex(ctx: MemoryBranchContext): Promise<BranchIndex> {
    return {
      branchId: this.id,
      displayName: this.displayName,
      summary: 'Semantic source has no pre-expanded entries. It is available only as a branch-scoped deep_search fallback after indexed expansion.',
      entries: [],
      generatedAt: ctx.now.toISOString(),
      source: 'vectors/memory.db',
    };
  }

  async expand(_ctx: MemoryBranchContext, request: BranchExpandRequest): Promise<BranchExpansion> {
    return { branchId: this.id, query: request.query, fragments: [], truncated: false };
  }

  async search(_ctx: MemoryBranchContext, request: BranchSearchRequest): Promise<MemoryFragment[]> {
    const hits = await this.store.search(request.query, request.limit);
    return hits.map((hit) => {
      const content = `## ${hit.date} semantic memory\n${hit.text}`;
      return {
        id: `vector:${hit.id}`,
        branchId: this.id,
        tier: hit.tier === 'daily' ? InjectionTier.T3_DETAIL : InjectionTier.T2_RELEVANT,
        priority: hit.score,
        content,
        tokenEstimate: estimateTokens(content),
        truncatable: true,
        dedupKey: `vector:${hit.id}`,
        matchReason: `Semantic similarity ${hit.score.toFixed(3)} for "${request.query}".`,
        metadata: {
          source: hit.source,
          kind: `vector-${hit.tier}`,
          generatedAt: `${hit.date}${hit.date.length === 10 ? 'T00:00:00.000Z' : ''}`,
          vectorId: hit.id,
          score: hit.score,
        },
      };
    });
  }
}
