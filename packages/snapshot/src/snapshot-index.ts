// @littlesheep/snapshot — snapshot-index.ts
// SnapshotIndex: tracks pre-write memory snapshots for rollback.
//
// Each snapshot is one entry in backups/index.json + a content file at
// backups/<tier>/<id>.md holding the file's pre-write content. When the index
// exceeds maxSnapshots, the oldest entries (and their content files) are
// pruned — the first real cleanup action in the memory pipeline.

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type SnapshotTier = 'long-term' | 'daily';

export interface SnapshotEntry {
  /** Unique id (timestamp-derived). */
  id: string;
  /** Which file was about to be written. */
  tier: SnapshotTier;
  /** For daily snapshots: the YYYY-MM-DD date. Undefined for long-term. */
  date?: string;
  /** Writer that triggered the snapshot. */
  operation: 'write' | 'append';
  /** Path to the pre-write content file, relative to snapshotDir. */
  beforeFile: string;
  /** ISO timestamp when the snapshot was captured. */
  ts: string;
}

interface IndexFile {
  entries: SnapshotEntry[];
}

export interface SnapshotIndexOptions {
  snapshotDir: string;
  maxSnapshots?: number;
}

export const DEFAULT_MAX_SNAPSHOTS = 50;

/** Make an ISO timestamp safe for Windows filenames (replace : and . with -). */
export function windowsSafeId(ts: string): string {
  return ts.replace(/[:.]/g, '-');
}

export class SnapshotIndex {
  private readonly indexPath: string;
  private readonly snapshotDir: string;
  private readonly maxSnapshots: number;

  constructor(opts: SnapshotIndexOptions) {
    this.snapshotDir = opts.snapshotDir;
    this.indexPath = join(opts.snapshotDir, 'index.json');
    this.maxSnapshots = opts.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
  }

  /** Directory holding snapshot content files + index.json (for diagnostics). */
  get directory(): string {
    return this.snapshotDir;
  }

  /** Read all entries (as persisted). Returns [] if index missing/corrupt. */
  async list(): Promise<SnapshotEntry[]> {
    if (!existsSync(this.indexPath)) return [];
    try {
      const raw = await readFile(this.indexPath, 'utf8');
      const data = JSON.parse(raw) as IndexFile;
      return Array.isArray(data.entries) ? data.entries : [];
    } catch {
      return [];
    }
  }

  /** All entries, newest-first (by ts). */
  async listNewestFirst(): Promise<SnapshotEntry[]> {
    const all = await this.list();
    return [...all].sort((a, b) => b.ts.localeCompare(a.ts));
  }

  /** Newest entry, optionally filtered by tier/date. Null if none match. */
  async getLatest(tier?: SnapshotTier, date?: string): Promise<SnapshotEntry | null> {
    const all = await this.listNewestFirst();
    for (const e of all) {
      if (tier && e.tier !== tier) continue;
      if (date && e.date !== date) continue;
      return e;
    }
    return null;
  }

  /** Look up an entry by id. Null if not found. */
  async get(id: string): Promise<SnapshotEntry | null> {
    const all = await this.list();
    for (const e of all) {
      if (e.id === id) return e;
    }
    return null;
  }

  /**
   * Add an entry + prune oldest beyond maxSnapshots.
   * Pruned entries have their content files best-effort deleted.
   */
  async add(entry: SnapshotEntry): Promise<void> {
    const all = await this.list();
    all.push(entry);
    // Newest-first sort (newest ts first).
    all.sort((a, b) => b.ts.localeCompare(a.ts));
    // Keep only the newest maxSnapshots; drop the rest + their content files.
    const kept = all.slice(0, this.maxSnapshots);
    const dropped = all.slice(this.maxSnapshots);
    for (const d of dropped) {
      const fp = join(this.snapshotDir, d.beforeFile);
      await unlink(fp).catch(() => {
        /* best-effort: file may already be gone */
      });
    }
    await mkdir(dirname(this.indexPath), { recursive: true });
    const file: IndexFile = { entries: kept };
    await writeFile(this.indexPath, JSON.stringify(file, null, 2), 'utf8');
  }

  /** Read the pre-write content for an entry. Throws if the content file is missing. */
  async readContent(entry: SnapshotEntry): Promise<string> {
    const fp = join(this.snapshotDir, entry.beforeFile);
    if (!existsSync(fp)) {
      throw new Error(`snapshot: content file missing for ${entry.id}: ${entry.beforeFile}`);
    }
    return readFile(fp, 'utf8');
  }
}
