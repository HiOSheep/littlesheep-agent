// @littlesheep/cli — commands/archive.ts
// `littlesheep memory archive [--dry-run] [--force] [--model <ref>]`
//
// Moves daily memory files older than 30 days into archive/YYYY/MM/DD.md,
// distills monthly + yearly summaries via LLM, and maintains the vector index
// (removes stale daily vectors, inserts summary vectors per the age rules).
// All daily files are preserved (moved, never deleted).
//
// Mirrors import-repo.ts structure: parse flags → resolve LLM → run → output.

import { join } from 'node:path';
import type { LlmClient } from '@littlesheep/llm';
import type { MemoryStoreLike } from '@littlesheep/types';
import { VectorStore } from '@littlesheep/vector';
import { archiveOldMemories } from '@littlesheep/memory-core';

export interface ArchiveFlags {
  /** Report what would happen without modifying files or the vector DB. */
  dryRun?: boolean;
  /** Regenerate summaries even if the .md file already exists. */
  force?: boolean;
  /** Override model ref (provider/model). */
  model?: string;
}

export const ARCHIVE_USAGE = `Usage: littlesheep memory archive [options]

  Archive daily memories older than 30 days. Moves files to archive/YYYY/MM/DD.md,
  distills monthly + yearly summaries via LLM, and maintains the vector index.

  Options:
    --dry-run           Report what would happen without modifying anything
    --force             Regenerate summaries even if they already exist
    --model <ref>       Override model (provider/model)
`;

/** Default embedding model + dimensions (text-embedding-3-small). */
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/** Parse archive flags from argv (the slice after 'memory archive'). */
export function parseArchiveFlags(argv: string[]): ArchiveFlags {
  const out: ArchiveFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--force') {
      out.force = true;
    } else if (a === '--model') {
      out.model = argv[++i] ?? '';
    } else if (a.startsWith('--model=')) {
      out.model = a.slice('--model='.length);
    }
  }
  return out;
}

export interface RunArchiveOptions {
  flags: ArchiveFlags;
  llm: LlmClient;
  model: string;
  memoryStore: MemoryStoreLike;
  archiveDir: string;
  vectorsDir: string;
  /** Injectable stdout (tests). */
  out?: (msg: string) => void;
  /** Injectable stderr (tests). */
  err?: (msg: string) => void;
}

/** Format a non-empty string array as "(a, b, c)" or "(none)". */
function fmtList(items: string[]): string {
  if (items.length === 0) return '(none)';
  return `(${items.join(', ')})`;
}

/** Format a date range from archived dates. */
function fmtDateRange(dates: string[]): string {
  if (dates.length === 0) return '(none)';
  if (dates.length === 1) return dates[0]!;
  return `${dates[0]} .. ${dates[dates.length - 1]!}`;
}

/** Execute an archive command. Sets process.exitCode on failure. */
export async function runArchive(opts: RunArchiveOptions): Promise<void> {
  const out = opts.out ?? ((m: string) => process.stdout.write(m));
  const err = opts.err ?? ((m: string) => process.stderr.write(m));
  const prefix = opts.flags.dryRun ? 'DRY RUN — ' : '';

  const dbPath = join(opts.vectorsDir, 'memory.db');
  const vectorStore = new VectorStore({
    dbPath,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    llm: opts.llm,
  });

  try {
    const result = await archiveOldMemories({
      memoryStore: opts.memoryStore,
      vectorStore,
      llm: opts.llm,
      model: opts.model,
      archiveDir: opts.archiveDir,
      dryRun: opts.flags.dryRun,
      force: opts.flags.force,
    });

    // Summarize.
    if (
      result.archivedDates.length === 0 &&
      result.generatedMonthly.length === 0 &&
      result.generatedYearly.length === 0 &&
      result.vectorInserted === 0 &&
      result.vectorRemoved === 0
    ) {
      out(`${prefix}Nothing to archive. All daily memories are within the 30-day window.\n`);
      return;
    }

    out(`${prefix}Archived ${result.archivedDates.length} daily files (${fmtDateRange(result.archivedDates)}).\n`);
    out(`${prefix}Generated ${result.generatedMonthly.length} monthly summaries ${fmtList(result.generatedMonthly)}.\n`);
    out(`${prefix}Generated ${result.generatedYearly.length} yearly summaries ${fmtList(result.generatedYearly)}.\n`);
    out(`${prefix}Vector index: +${result.vectorInserted} inserted, -${result.vectorRemoved} removed.\n`);
  } catch (e) {
    err(`archive failed: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    vectorStore.close();
  }
}
