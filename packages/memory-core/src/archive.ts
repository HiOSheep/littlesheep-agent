// @littlesheep/memory-core — archive.ts
// Tiered memory archival: move daily files older than `maxAgeDays` into
// `archive/YYYY/MM/DD.md`, distill monthly + yearly summaries via LLM, and
// maintain the vector index so the "hot tier" stays clean:
//
//   - daily vectors:        removed once the daily is archived (>30 days)
//   - monthly-summary:      in vector DB if the month is within the last 12 months
//   - yearly-summary:       in vector DB if the year ended >12 months ago
//
// All daily files are PRESERVED (moved, never deleted). The vector DB is a
// derived index; `memory archive --force` regenerates summaries. Deep search
// (`memory_deep_search`) reads the full archive directly without touching the
// vector DB, so old content is always queryable even when not indexed.
//
// Note: the LLM JSON-call helper is inlined here (instead of importing
// `callLlmForJson` from `@littlesheep/harness`) to avoid a workspace cycle
// (harness already depends on memory-core).

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import type { MemoryStoreLike } from '@littlesheep/types';
import type { VectorStore } from '@littlesheep/vector';
import { validateMemoryContent } from '@littlesheep/safety';

export interface ArchiveOptions {
  memoryStore: MemoryStoreLike;
  vectorStore: VectorStore;
  llm: LlmClient;
  model: string;
  /** Root archive directory (e.g. <dataDir>/archive). */
  archiveDir: string;
  /** Daily files older than this many days are archived. Default 30. */
  maxAgeDays?: number;
  /** Report what would happen without modifying files or the vector DB. */
  dryRun?: boolean;
  /** Regenerate summaries even if the .md file already exists. */
  force?: boolean;
  /** Override "now" for tests. */
  now?: Date;
}

export interface ArchiveResult {
  /** Daily dates (YYYY-MM-DD) moved to the archive. */
  archivedDates: string[];
  /** Months (YYYY-MM) whose summary was (re)generated. */
  generatedMonthly: string[];
  /** Years (YYYY) whose summary was (re)generated. */
  generatedYearly: string[];
  /** Vector records removed. */
  vectorRemoved: number;
  /** Vector records inserted. */
  vectorInserted: number;
}

const DEFAULT_MAX_AGE_DAYS = 30;
/** Generous length cap for distilled summaries (vs. 500 for daily entries). */
const SUMMARY_MAX_LENGTH = 4000;

// ─── Date helpers ────────────────────────────────────────────────────────

/** Format a year + 1-based month as YYYY-MM. */
function formatMonth(year: number, month1: number): string {
  return `${year}-${String(month1).padStart(2, '0')}`;
}

/** YYYY-MM that is exactly `monthsBack` months before `now`. */
function monthMinus(now: Date, monthsBack: number): string {
  const d = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
  return formatMonth(d.getFullYear(), d.getMonth() + 1);
}

/** YYYY-MM-DD that is `days` days before `now` (UTC, matching store.ts). */
function dateMinusDays(now: Date, days: number): string {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ─── LLM JSON helper (inlined to avoid harness cycle) ────────────────────

/** Extract the first JSON object {...} from a string (handles markdown wraps). */
function extractJson(content: string): unknown | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Call llm.chat and parse JSON output, retrying on parse failure. */
async function callLlmForJsonLocal<T>(
  llm: LlmClient,
  model: string,
  messages: ChatMessage[],
  maxAttempts: number,
  maxTokens: number,
): Promise<T | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await llm.chat({ model, messages, temperature: 0, max_tokens: maxTokens });
    const parsed = extractJson(res.content) as T | null;
    if (parsed !== null) return parsed;
  }
  return null;
}

// ─── Distillation ────────────────────────────────────────────────────────

interface DistilledSummary {
  summary: string;
  keyEvents: string[];
  topics: string[];
}

const MONTH_SYSTEM_PROMPT =
  '你是记忆蒸馏器。将以下日记条目精简为结构化月度摘要。' +
  '提取关键事件与主题，去除冗余与敏感细节。只返回 JSON，不要其他文本。';

const YEAR_SYSTEM_PROMPT =
  '你是记忆蒸馏器。将以下月度摘要汇编为结构化年度摘要。' +
  '提取年度主线、关键事件与主题。只返回 JSON，不要其他文本。';

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Distill a month's daily entries into a summary. Returns null on failure. */
async function distillMonth(
  opts: ArchiveOptions,
  month: string,
): Promise<DistilledSummary | null> {
  const [yyyy, mm] = month.split('-');
  const monthDir = join(opts.archiveDir, yyyy!, mm!);
  let names: string[] = [];
  try {
    names = await readdir(monthDir);
  } catch {
    return null;
  }
  const dayFiles = names.filter((n) => /^\d{2}\.md$/.test(n)).sort();
  if (dayFiles.length === 0) return null;

  const chunks: string[] = [];
  for (const df of dayFiles) {
    const content = await readFile(join(monthDir, df), 'utf8');
    chunks.push(`## ${yyyy}-${mm}-${df.replace(/\.md$/, '')}\n\n${content.trim()}`);
  }
  const userContent = `月份: ${month}\n\n日记内容:\n\n${chunks.join('\n\n---\n\n')}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: MONTH_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
  const parsed = await callLlmForJsonLocal<DistilledSummary>(opts.llm, opts.model, messages, 2, 1500);
  if (!parsed || typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    return null;
  }
  return {
    summary: parsed.summary,
    keyEvents: asStringArray(parsed.keyEvents),
    topics: asStringArray(parsed.topics),
  };
}

/** Distill a year's monthly summaries into a yearly summary. Returns null on failure. */
async function distillYear(
  opts: ArchiveOptions,
  year: string,
): Promise<DistilledSummary | null> {
  const yearDir = join(opts.archiveDir, year);
  let names: string[] = [];
  try {
    names = await readdir(yearDir);
  } catch {
    return null;
  }
  const monthDirs = names.filter((n) => /^\d{2}$/.test(n)).sort();
  if (monthDirs.length === 0) return null;

  const chunks: string[] = [];
  for (const md of monthDirs) {
    const summaryPath = join(yearDir, md, 'summary.md');
    if (!existsSync(summaryPath)) continue;
    const content = await readFile(summaryPath, 'utf8');
    chunks.push(`## ${year}-${md} 月度摘要\n\n${content.trim()}`);
  }
  if (chunks.length === 0) return null;

  const userContent = `年份: ${year}\n\n月度摘要:\n\n${chunks.join('\n\n---\n\n')}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: YEAR_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
  const parsed = await callLlmForJsonLocal<DistilledSummary>(opts.llm, opts.model, messages, 2, 2000);
  if (!parsed || typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    return null;
  }
  return {
    summary: parsed.summary,
    keyEvents: asStringArray(parsed.keyEvents),
    topics: asStringArray(parsed.topics),
  };
}

/** Render a distilled summary to markdown for disk storage. */
function renderSummaryMarkdown(title: string, d: DistilledSummary): string {
  const lines: string[] = [`# ${title}`, '', d.summary.trim()];
  if (d.keyEvents.length > 0) {
    lines.push('', '## Key Events');
    for (const e of d.keyEvents) lines.push(`- ${e}`);
  }
  if (d.topics.length > 0) {
    lines.push('', '## Topics');
    for (const t of d.topics) lines.push(`- ${t}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Validate distilled text against injection patterns before persisting.
 * Returns the cleaned text, or null if rejected.
 */
function guardSummary(text: string): string | null {
  const res = validateMemoryContent(text, { maxLength: SUMMARY_MAX_LENGTH });
  if (!res.ok || !res.cleaned) return null;
  const cleaned = res.cleaned.trim();
  return cleaned.length > 0 ? cleaned : null;
}

// ─── Main entry ──────────────────────────────────────────────────────────

export async function archiveOldMemories(opts: ArchiveOptions): Promise<ArchiveResult> {
  const now = opts.now ?? new Date();
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const cutoffDate = dateMinusDays(now, maxAgeDays);
  // Months >= monthCutoff (last 12 months) stay in the vector DB.
  const monthCutoff = monthMinus(now, 12);

  const result: ArchiveResult = {
    archivedDates: [],
    generatedMonthly: [],
    generatedYearly: [],
    vectorRemoved: 0,
    vectorInserted: 0,
  };

  // 1. Identify expired daily dates (lexicographic compare on YYYY-MM-DD).
  const allDates = await opts.memoryStore.listDailyDates();
  const expired = allDates.filter((d) => d < cutoffDate);

  if (expired.length === 0) {
    // Still run the maturation/cleanup sweeps so the vector index stays correct
    // even when no new dailies cross the threshold this run.
    await runMaturationSweep(opts, now, monthCutoff, result);
    return result;
  }

  // 2. Move each expired daily file to archive/YYYY/MM/DD.md + remove its vectors.
  const affectedMonths = new Set<string>();
  for (const date of expired) {
    const content = await opts.memoryStore.readDaily(date);
    if (!content) continue;
    const [yyyy, mm, dd] = date.split('-');
    const destDir = join(opts.archiveDir, yyyy!, mm!);
    const destPath = join(destDir, `${dd}.md`);
    if (!opts.dryRun) {
      await mkdir(destDir, { recursive: true });
      await writeFile(destPath, content, 'utf8');
      const srcPath = opts.memoryStore.dailyFile(date);
      try {
        await unlink(srcPath);
      } catch {
        // already gone — harmless
      }
      result.vectorRemoved += opts.vectorStore.removeBySource(srcPath);
    }
    result.archivedDates.push(date);
    affectedMonths.add(`${yyyy}-${mm}`);
  }

  // 3. Generate monthly summaries for affected months.
  const affectedYears = new Set<string>();
  for (const month of affectedMonths) {
    const [yyyy] = month.split('-');
    affectedYears.add(yyyy!);
    const summaryPath = join(opts.archiveDir, yyyy!, month.slice(5, 7), 'summary.md');
    if (!opts.force && existsSync(summaryPath)) {
      // Already distilled; ensure vector membership matches the age rule.
      if (!opts.dryRun) {
        opts.vectorStore.removeBySource(summaryPath);
        if (month >= monthCutoff) {
          const existing = await readFile(summaryPath, 'utf8');
          const guarded = guardSummary(existing);
          if (guarded) {
            await opts.vectorStore.insert({
              text: guarded,
              tier: 'monthly-summary',
              date: month,
              source: summaryPath,
            });
            result.vectorInserted++;
          }
        }
      }
      continue;
    }
    const distilled = await distillMonth(opts, month);
    if (distilled === null) continue;
    const guarded = guardSummary(distilled.summary);
    if (guarded === null) continue;
    if (!opts.dryRun) {
      await mkdir(join(opts.archiveDir, yyyy!, month.slice(5, 7)), { recursive: true });
      await writeFile(summaryPath, renderSummaryMarkdown(`Monthly Summary — ${month}`, distilled), 'utf8');
      opts.vectorStore.removeBySource(summaryPath);
      if (month >= monthCutoff) {
        await opts.vectorStore.insert({
          text: guarded,
          tier: 'monthly-summary',
          date: month,
          source: summaryPath,
        });
        result.vectorInserted++;
      }
    }
    result.generatedMonthly.push(month);
  }

  // 4. Generate yearly summaries for affected PAST years (current year is incomplete).
  for (const year of affectedYears) {
    if (Number(year) >= now.getFullYear()) continue;
    const summaryPath = join(opts.archiveDir, year, 'summary.md');
    const aged = `${year}-12` < monthCutoff;
    if (!opts.force && existsSync(summaryPath)) {
      // Existing yearly summary — re-index if it has aged in.
      if (!opts.dryRun && aged) {
        opts.vectorStore.removeBySource(summaryPath);
        const existing = await readFile(summaryPath, 'utf8');
        const guarded = guardSummary(existing);
        if (guarded) {
          await opts.vectorStore.insert({
            text: guarded,
            tier: 'yearly-summary',
            date: year,
            source: summaryPath,
          });
          result.vectorInserted++;
        }
      }
      continue;
    }
    const distilled = await distillYear(opts, year);
    if (distilled === null) continue;
    const guarded = guardSummary(distilled.summary);
    if (guarded === null) continue;
    if (!opts.dryRun) {
      await mkdir(join(opts.archiveDir, year), { recursive: true });
      await writeFile(summaryPath, renderSummaryMarkdown(`Yearly Summary — ${year}`, distilled), 'utf8');
      opts.vectorStore.removeBySource(summaryPath);
      if (aged) {
        await opts.vectorStore.insert({
          text: guarded,
          tier: 'yearly-summary',
          date: year,
          source: summaryPath,
        });
        result.vectorInserted++;
      }
    }
    result.generatedYearly.push(year);
  }

  // 5. Maturation + cleanup sweeps.
  await runMaturationSweep(opts, now, monthCutoff, result);

  return result;
}

/**
 * Keep the vector index aligned with the age rules without distilling:
 *   - remove monthly-summary vectors older than 12 months
 *   - remove daily vectors older than maxAgeDays (orphan safety net)
 *   - insert yearly-summary vectors for archived years that have aged in
 *     but were not "affected" this run
 */
async function runMaturationSweep(
  opts: ArchiveOptions,
  now: Date,
  monthCutoff: string,
  result: ArchiveResult,
): Promise<void> {
  if (opts.dryRun) return;

  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;

  // Remove monthly-summary vectors whose month is strictly older than the
  // 12-month window. `until` is inclusive, so use the month just before the cutoff.
  const staleMonthUntil = monthMinus(now, 13);
  result.vectorRemoved += opts.vectorStore.removeByTierAndDateRange(
    'monthly-summary',
    undefined,
    staleMonthUntil,
  );

  // Remove orphan daily vectors older than the archive threshold.
  const staleDailyUntil = dateMinusDays(now, maxAgeDays);
  result.vectorRemoved += opts.vectorStore.removeByTierAndDateRange(
    'daily',
    undefined,
    staleDailyUntil,
  );

  // Insert yearly-summary vectors for archived years that have aged in but
  // are missing from the index (e.g. the year crossed the 12-month boundary
  // between runs without a new archive touching it).
  const existingYearlySources = new Set(
    opts.vectorStore.listByTier('yearly-summary').map((r) => r.source),
  );
  let yearDirs: string[] = [];
  try {
    yearDirs = await readdir(opts.archiveDir);
  } catch {
    return; // no archive yet
  }
  for (const year of yearDirs) {
    if (!/^\d{4}$/.test(year)) continue;
    if (Number(year) >= now.getFullYear()) continue;
    if (!(`${year}-12` < monthCutoff)) continue; // not aged in yet
    const summaryPath = join(opts.archiveDir, year, 'summary.md');
    if (!existsSync(summaryPath)) continue;
    if (existingYearlySources.has(summaryPath)) continue;
    const text = await readFile(summaryPath, 'utf8');
    const guarded = guardSummary(text);
    if (guarded === null) continue;
    await opts.vectorStore.insert({
      text: guarded,
      tier: 'yearly-summary',
      date: year,
      source: summaryPath,
    });
    result.vectorInserted++;
  }
}
