// @littlesheep/experience — experience-store.ts
// Structured experience database for the agent's self-evolution.
//
// ExperienceEntry holds durable lessons/facts extracted by EVOLVE (category=
// 'evolution') or repo-import (category='repo-import'). Each entry carries a
// confidence score that decays over time; entries below a threshold are pruned
// by decay() — the project's second real cleanup action (after snapshot's
// maxSnapshots pruning).
//
// Persistence: a single index.json holds the full entries (content included)
// so search() is one read + in-memory filter, not N file reads. This mirrors
// the SnapshotIndex pattern. append/decay rewrite the whole file, which is
// acceptable: append is rare (once per EVOLVE run) and decay is manual (CLI).
//
// Crash safety (writeIndex): uses atomicWrite (tmp + rename) from
// @littlesheep/memory-core. A process killed mid-write leaves either the old
// index.json intact or nothing — never a truncated half-JSON. Without this,
// a crash during writeIndex would corrupt index.json, and the next readIndex
// would silently return [] (see below), causing append() to overwrite ALL
// historical experience with a single entry.
//
// Corrupt recovery (readIndex): if index.json exists but fails to parse,
// the raw bytes are backed up to <rootDir>/backups/index.corrupt-<ts>-<rand>.json
// BEFORE returning []. This preserves forensic evidence (the corruption cause
// is often visible in the raw bytes) and prevents the next writeIndex from
// silently destroying the only copy. A console.warn is emitted so operators
// notice the event. The backup is best-effort: failure to write it does not
// block the read path.
//
// Injection defence: append() validates content via validateMemoryContent
// (reused from @littlesheep/safety). Experience may originate from polluted
// web pages (repo-import), so the same defence as memory writes applies.
// Rejects throw — EVOLVE's fire-and-forget swallows; import-repo skips the
// entry with a warning. No separate quarantine: quarantine is memory-tier only.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { validateMemoryContent } from '@littlesheep/safety';
import { DEFAULT_MAX_LENGTH } from '@littlesheep/safety';
import { atomicWrite } from '@littlesheep/memory-core';

export interface ExperienceEntry {
  /** Unique id: <windowsSafeId(createdAt)>-<rand6>. */
  id: string;
  /** 'evolution' | 'repo-import' | 'capture' | ... */
  category: string;
  /** The durable lesson/fact (cleaned of injection patterns). */
  content: string;
  /** 0-1. Decays over time; pruned below deleteBelow. */
  confidence: number;
  /** 'evolve' | 'import-repo' | ... */
  source: string;
  /** Free-form tags for filtering. */
  tags: string[];
  /** ISO timestamp. */
  createdAt: string;
  /** Optional run id (EVOLVE writes this). */
  runId?: string;
  /** Optional repo name (import-repo writes this). */
  provenance?: string;
}

/** Input to append(): everything except auto-generated fields. */
export interface ExperienceInput {
  category: string;
  content: string;
  source: string;
  tags?: string[];
  confidence?: number;
  runId?: string;
  provenance?: string;
}

export interface ExperienceStoreOptions {
  /** Directory holding index.json (branding's experience/ dir). */
  rootDir: string;
  /** Multiplier applied by decay(). Default 0.95. */
  decayFactor?: number;
  /** Entries with confidence below this after decay are deleted. Default 0.1. */
  deleteBelow?: number;
  /** Max entries kept; oldest pruned on append. Default 500. */
  maxEntries?: number;
  /** Max chars per entry content (passed to validateMemoryContent). Default 500. */
  maxLength?: number;
}

export interface SearchQuery {
  category?: string;
  tag?: string;
  limit?: number;
}

interface IndexFile {
  entries: ExperienceEntry[];
}

export const DEFAULT_DECAY_FACTOR = 0.95;
export const DEFAULT_DELETE_BELOW = 0.1;
export const DEFAULT_MAX_ENTRIES = 500;

/** Make an ISO timestamp safe for filenames (replace : and . with -). */
function windowsSafeId(ts: string): string {
  return ts.replace(/[:.]/g, '-');
}

/** Random lowercase alphanumeric suffix of given length. */
function randomSuffix(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)] ?? '0';
  }
  return out;
}

/** Round to 6 decimal places to avoid float drift across decays. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export class ExperienceStore {
  private readonly rootDir: string;
  private readonly indexPath: string;
  private readonly decayFactor: number;
  private readonly deleteBelow: number;
  private readonly maxEntries: number;
  private readonly maxLength: number;

  constructor(opts: ExperienceStoreOptions) {
    this.rootDir = opts.rootDir;
    this.indexPath = join(opts.rootDir, 'index.json');
    this.decayFactor = opts.decayFactor ?? DEFAULT_DECAY_FACTOR;
    this.deleteBelow = opts.deleteBelow ?? DEFAULT_DELETE_BELOW;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  }

  /** Directory holding index.json (for diagnostics). */
  get directory(): string {
    return this.rootDir;
  }

  /**
   * Read all entries. Returns [] if index missing/corrupt (never throws).
   *
   * Corrupt recovery: if index.json exists but JSON.parse fails, the raw
   * bytes are backed up to <rootDir>/backups/ before returning []. This
   * prevents the next writeIndex() from silently overwriting the only copy
   * of the corrupt data — without the backup, a single crash-induced
   * truncation would cascade into permanent loss of ALL historical
   * experience (the next append() reads [], pushes one entry, writes back
   * a 1-entry index, and the old data is gone forever).
   */
  private async readIndex(): Promise<ExperienceEntry[]> {
    if (!existsSync(this.indexPath)) return [];
    let raw: string;
    try {
      raw = await readFile(this.indexPath, 'utf8');
    } catch {
      // File exists but can't be read (locked, permission, EBUSY). There's
      // no content to back up — return [] and let the caller decide whether
      // to proceed. writeIndex is NOT called from readIndex, so the file is
      // not overwritten here.
      return [];
    }
    try {
      const data = JSON.parse(raw) as IndexFile;
      return Array.isArray(data.entries) ? data.entries : [];
    } catch {
      // Corrupt JSON — back up the raw bytes for forensic analysis before
      // the next writeIndex overwrites index.json. Best-effort: backup
      // failure does not block the read.
      await this.backupCorruptIndex(raw);
      return [];
    }
  }

  /**
   * Back up corrupt index.json raw bytes to <rootDir>/backups/.
   * Filename: index.corrupt-<windowsSafeId(iso)>-<rand4>.json
   * The random suffix guards against same-millisecond collisions.
   * Best-effort: errors are swallowed (caller already in an error path).
   */
  private async backupCorruptIndex(raw: string): Promise<void> {
    const backupDir = join(this.rootDir, 'backups');
    const ts = windowsSafeId(new Date().toISOString());
    const backupPath = join(backupDir, `index.corrupt-${ts}-${randomSuffix(4)}.json`);
    try {
      await mkdir(backupDir, { recursive: true });
      await writeFile(backupPath, raw, 'utf8');
      // eslint-disable-next-line no-console
      console.warn(
        `[experience] index.json was corrupt — backed up to ${backupPath}. ` +
          `The next write will start fresh; inspect the backup to recover data.`,
      );
    } catch {
      // Backup failed (disk full, permission, etc.). We must not throw — the
      // caller (readIndex) is already in a recovery path. The corrupt file
      // remains in place; the next writeIndex will overwrite it. Data may
      // be lost, but failing here would crash the agent for no benefit.
      // eslint-disable-next-line no-console
      console.warn(
        `[experience] index.json is corrupt AND backup failed — ` +
          `historical experience may be lost on the next write.`,
      );
    }
  }

  private async writeIndex(entries: ExperienceEntry[]): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });
    const file: IndexFile = { entries };
    // Atomic write (tmp + rename): a crash mid-write leaves either the old
    // index.json or nothing — never a truncated half-JSON. This is the
    // critical defence against readIndex's corrupt-recovery path being
    // triggered in the first place.
    await atomicWrite(this.indexPath, JSON.stringify(file, null, 2));
  }

  /**
   * Append a new experience entry.
   * Validates content against injection patterns (rejects throw).
   * Prunes oldest entries beyond maxEntries.
   * Returns the fully-formed entry (with generated id + defaults applied).
   */
  async append(input: ExperienceInput): Promise<ExperienceEntry> {
    // 1. Injection defence: validate + clean content.
    const result = validateMemoryContent(input.content, { maxLength: this.maxLength });
    if (!result.ok) {
      throw new Error(
        `experience: content rejected: ${result.reason} (pattern: ${result.matchedPatternId ?? 'n/a'})`,
      );
    }
    const cleaned = result.cleaned ?? input.content;

    // 2. Build full entry with defaults.
    const now = new Date().toISOString();
    const entry: ExperienceEntry = {
      id: `${windowsSafeId(now)}-${randomSuffix(6)}`,
      category: input.category,
      content: cleaned,
      confidence: round6(input.confidence ?? 0.5),
      source: input.source,
      tags: input.tags ?? [],
      createdAt: now,
    };
    if (input.runId !== undefined) entry.runId = input.runId;
    if (input.provenance !== undefined) entry.provenance = input.provenance;

    // 3. Append + prune oldest beyond maxEntries.
    const entries = await this.readIndex();
    entries.push(entry);
    // Newest-first by createdAt; keep only maxEntries newest.
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const kept = entries.slice(0, this.maxEntries);

    await this.writeIndex(kept);
    return entry;
  }

  /** List entries, optionally filtered by category/tag, limited. */
  async list(query?: SearchQuery): Promise<ExperienceEntry[]> {
    let entries = await this.readIndex();
    if (query?.category) {
      const cat = query.category;
      entries = entries.filter((e) => e.category === cat);
    }
    if (query?.tag) {
      const tag = query.tag;
      entries = entries.filter((e) => e.tags.includes(tag));
    }
    if (query?.limit !== undefined) {
      entries = entries.slice(0, query.limit);
    }
    return entries;
  }

  /**
   * Full-text search: entries whose content includes the query (case-insensitive).
   * Results sorted by confidence descending (most confident first).
   */
  async search(query: string, limit?: number): Promise<ExperienceEntry[]> {
    const lower = query.toLowerCase();
    let entries = await this.readIndex();
    entries = entries.filter((e) => e.content.toLowerCase().includes(lower));
    entries.sort((a, b) => b.confidence - a.confidence);
    if (limit !== undefined) {
      entries = entries.slice(0, limit);
    }
    return entries;
  }

  /**
   * Decay all entries: confidence *= decayFactor; drop entries below deleteBelow.
   * Returns counts before/after. Manual/cron trigger (not called from EVOLVE).
   */
  async decay(): Promise<{ before: number; after: number }> {
    const entries = await this.readIndex();
    const before = entries.length;
    const survivors: ExperienceEntry[] = [];
    for (const e of entries) {
      const decayed = round6(e.confidence * this.decayFactor);
      if (decayed < this.deleteBelow) continue; // drop
      survivors.push({ ...e, confidence: decayed });
    }
    await this.writeIndex(survivors);
    return { before, after: survivors.length };
  }
}
