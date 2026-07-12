// @littlesheep/memory-core — vector-decorator.ts
// Decorator that wraps a MemoryStoreLike and indexes new daily entries into
// the vector store on `appendDaily`. Only `appendDaily` triggers indexing —
// `writeDaily` (full overwrite) and `appendLongTerm` (manual edits) do not,
// since those are rollback/manual-edit paths. The vector index can be rebuilt
// via `memory archive --force`.
//
// Vector insertion is fire-and-forget: the promise is not awaited
// and failures are swallowed. Rationale: the vector DB is a derived index;
// an embedding API failure must never block a memory write. The trade-off is
// that the user may briefly not find the latest entry via vector search —
// acceptable for a personal agent.

import type { MemoryStoreLike } from '@littlesheep/types';
import type { VectorStore } from '@littlesheep/vector';

/**
 * Wraps a MemoryStoreLike so that `appendDaily` also inserts the entry text
 * into the vector store for semantic search. All other methods delegate
 * directly to the inner store.
 */
export class VectorIndexedMemoryStore implements MemoryStoreLike {
  constructor(
    private readonly inner: MemoryStoreLike,
    private readonly vectorStore: VectorStore,
  ) {}

  async appendDaily(date: string, text: string): Promise<void> {
    // Write to the file first — this is the source of truth.
    await this.inner.appendDaily(date, text);
    // Fire-and-forget: index the new bullet for semantic search. Failures
    // (e.g. embedding API errors) are swallowed so they never break the write.
    this.vectorStore
      .insert({
        text,
        tier: 'daily',
        date,
        source: this.inner.dailyFile(date),
      })
      .catch(() => {});
  }

  // ─── Pure delegation (no vector side-effects) ────────────────────────────

  readLongTerm(): Promise<string> {
    return this.inner.readLongTerm();
  }
  writeLongTerm(content: string): Promise<void> {
    return this.inner.writeLongTerm(content);
  }
  appendLongTerm(text: string): Promise<void> {
    return this.inner.appendLongTerm(text);
  }
  dailyFile(date: string): string {
    return this.inner.dailyFile(date);
  }
  readDaily(date: string): Promise<string> {
    return this.inner.readDaily(date);
  }
  writeDaily(date: string, content: string): Promise<void> {
    return this.inner.writeDaily(date, content);
  }
  listDailyDates(): Promise<string[]> {
    return this.inner.listDailyDates();
  }
  today(): string {
    return this.inner.today();
  }
  get longTermPath(): string {
    return this.inner.longTermPath;
  }
  get dailyDirPath(): string {
    return this.inner.dailyDirPath;
  }
}
