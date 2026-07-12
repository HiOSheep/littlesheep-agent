// @littlesheep/snapshot — snapshot-memory-store.ts
// SnapshotMemoryStore: decorator over MemoryStoreLike that captures pre-write
// file content before forwarding writes.
//
// Wrap order (outer → inner):  Snapshot → Safe → base
//   - Snapshot reads the "before" content, persists it (fire-and-forget), then
//     forwards the write to the inner store (Safe → base).
//   - On rollback, the before-content is restored directly via writeLongTerm/
//     writeDaily on the BASE store, bypassing Safe (historical content is
//     trusted — never re-validated).
//
// The "before" READ is awaited (must complete before the write to capture the
// true pre-write state). The snapshot PERSIST (content file + index update) is
// fire-and-forget so persistence failure does not block the write.

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { MemoryStoreLike } from '@littlesheep/types';
import {
  SnapshotIndex,
  windowsSafeId,
  type SnapshotEntry,
  type SnapshotTier,
} from './snapshot-index.js';

export interface SnapshotMemoryStoreOptions {
  /** Directory holding index.json + content files (use dirs.backups). */
  snapshotDir: string;
  /** Max entries before oldest are pruned. Default 50. */
  maxSnapshots?: number;
  /** Injectable index (for tests). */
  index?: SnapshotIndex;
}

export class SnapshotMemoryStore implements MemoryStoreLike {
  private readonly inner: MemoryStoreLike;
  private readonly snapshotDir: string;
  private readonly index: SnapshotIndex;

  constructor(inner: MemoryStoreLike, opts: SnapshotMemoryStoreOptions) {
    this.inner = inner;
    this.snapshotDir = opts.snapshotDir;
    this.index = opts.index ?? new SnapshotIndex({
      snapshotDir: opts.snapshotDir,
      maxSnapshots: opts.maxSnapshots,
    });
  }

  /** The underlying index (for CLI rollback + diagnostics). */
  get snapshots(): SnapshotIndex {
    return this.index;
  }

  /** Read the pre-write content of the target file. '' if unreadable (first write). */
  private async readBefore(read: () => Promise<string>): Promise<string> {
    try {
      return await read();
    } catch {
      // File may not exist yet (first write) → empty before-content is valid.
      return '';
    }
  }

  /** Persist a snapshot (content file + index entry) without blocking writes. */
  private persistSnapshot(
    before: string,
    tier: SnapshotTier,
    date: string | undefined,
    operation: 'write' | 'append',
  ): void {
    (async () => {
      const ts = new Date().toISOString();
      const id = windowsSafeId(ts);
      const subdir = date ? join('daily', date) : 'long-term';
      const beforeFile = join(subdir, `${id}.md`);
      const beforePath = join(this.snapshotDir, beforeFile);
      await mkdir(dirname(beforePath), { recursive: true });
      await writeFile(beforePath, before, 'utf8');
      const entry: SnapshotEntry = { id, tier, date, operation, beforeFile, ts };
      await this.index.add(entry);
    })().catch(() => {
      /* Snapshot persistence is best-effort and must not block the write. */
    });
  }

  // ─── Writers (capture before → forward) ────────────────────────────────

  async writeLongTerm(content: string): Promise<void> {
    const before = await this.readBefore(() => this.inner.readLongTerm());
    this.persistSnapshot(before, 'long-term', undefined, 'write');
    return this.inner.writeLongTerm(content);
  }

  async appendLongTerm(text: string): Promise<void> {
    const before = await this.readBefore(() => this.inner.readLongTerm());
    this.persistSnapshot(before, 'long-term', undefined, 'append');
    return this.inner.appendLongTerm(text);
  }

  async writeDaily(date: string, content: string): Promise<void> {
    const before = await this.readBefore(() => this.inner.readDaily(date));
    this.persistSnapshot(before, 'daily', date, 'write');
    return this.inner.writeDaily(date, content);
  }

  async appendDaily(date: string, text: string): Promise<void> {
    const before = await this.readBefore(() => this.inner.readDaily(date));
    this.persistSnapshot(before, 'daily', date, 'append');
    return this.inner.appendDaily(date, text);
  }

  // ─── Readers (pure pass-through) ───────────────────────────────────────

  readLongTerm(): Promise<string> {
    return this.inner.readLongTerm();
  }
  readDaily(date: string): Promise<string> {
    return this.inner.readDaily(date);
  }
  listDailyDates(): Promise<string[]> {
    return this.inner.listDailyDates();
  }
  dailyFile(date: string): string {
    return this.inner.dailyFile(date);
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
