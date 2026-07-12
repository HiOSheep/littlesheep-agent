// @littlesheep/types — memory.ts
// Memory record + search types.

/** Where a memory record lives. */
export type MemoryTier =
  | 'long-term' // MEMORY.md (curated summary)
  | 'daily' // memory/YYYY-MM-DD.md
  | 'insight' // captured runtime insight
  | 'archive' // archived daily (memory/YYYY-MM-DD.md moved to archive/YYYY/MM/DD.md)
  | 'monthly-summary' // archive/YYYY/MM/summary.md
  | 'yearly-summary'; // archive/YYYY/summary.md

/** A single memory entry (one bullet / one captured note). */
export interface MemoryRecord {
  /** ISO date or timestamp. */
  date: string;
  tier: MemoryTier;
  /** The memory text (markdown bullet or short paragraph). */
  text: string;
  /** Source: stage that wrote it, or 'distill'. */
  source?: string;
  /** Optional tags for search filtering. */
  tags?: string[];
}

/** A search hit. */
export interface MemoryHit {
  /** File path that matched. */
  file: string;
  /** Matched line number (1-based). */
  line?: number;
  /** Context snippet around the match. */
  snippet: string;
  /** Tier inferred from file. */
  tier: MemoryTier;
}

/** Search query. */
export interface SearchQuery {
  /** The search text. */
  query: string;
  /** Max results. */
  limit?: number;
  /** Restrict to these tiers. */
  tiers?: MemoryTier[];
  /** Restrict to date range (inclusive). */
  since?: string;
  until?: string;
}

/** Prelude block injected at ENTER stage. */
export interface MemoryPrelude {
  /** ISO date generated. */
  generatedAt: string;
  /** Number of daily files included. */
  daysIncluded: number;
  /** Total characters injected. */
  chars: number;
  /** Whether any file was truncated. */
  truncated: boolean;
  /** The markdown block to inject. */
  content: string;
}

/**
 * Structural interface for a memory store.
 *
 * `MemoryStore` (in `@littlesheep/memory-core`) implements this. Decorators
 * (`SafeMemoryStore`, `SnapshotMemoryStore`) depend on this interface so they
 * can wrap either the real store or test mocks interchangeably.
 */
export interface MemoryStoreLike {
  readLongTerm(): Promise<string>;
  writeLongTerm(content: string): Promise<void>;
  appendLongTerm(text: string): Promise<void>;
  /** Resolve the daily file path for a date (YYYY-MM-DD). Sync. */
  dailyFile(date: string): string;
  readDaily(date: string): Promise<string>;
  appendDaily(date: string, text: string): Promise<void>;
  writeDaily(date: string, content: string): Promise<void>;
  listDailyDates(): Promise<string[]>;
  /** Today's date as YYYY-MM-DD. Sync. */
  today(): string;
  readonly longTermPath: string;
  readonly dailyDirPath: string;
}
