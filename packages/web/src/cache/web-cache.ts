import type { FetchedDocument } from '@littlesheep/types';

export interface WebCache {
  get(key: string, now?: number): Promise<FetchedDocument | undefined>;
  set(key: string, document: FetchedDocument, now?: number): Promise<void>;
  clear(): Promise<void>;
  stats(): { entries: number; bytes: number; hits: number; misses: number };
}

interface CacheEntry {
  document: FetchedDocument;
  storedAt: number;
  bytes: number;
  lastUsed: number;
}

/** Process-local bounded LRU cache. It never persists raw query or page data. */
export class MemoryWebCache implements WebCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(key: string, now = this.clock()): Promise<FetchedDocument | undefined> {
    const entry = this.entries.get(key);
    if (!entry || now - entry.storedAt > this.ttlMs) {
      this.misses += 1;
      if (entry) this.remove(key, entry);
      return undefined;
    }
    this.hits += 1;
    entry.lastUsed = now;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.document);
  }

  async set(key: string, document: FetchedDocument, now = this.clock()): Promise<void> {
    const clone = structuredClone(document);
    const bytes = Buffer.byteLength(JSON.stringify(clone), 'utf8');
    if (bytes > this.maxBytes || this.maxBytes <= 0) return;
    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);
    this.entries.set(key, { document: clone, storedAt: now, lastUsed: now, bytes });
    this.bytes += bytes;
    this.evict();
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.bytes = 0;
  }

  stats(): { entries: number; bytes: number; hits: number; misses: number } {
    return { entries: this.entries.size, bytes: this.bytes, hits: this.hits, misses: this.misses };
  }

  private evict(): void {
    while (this.bytes > this.maxBytes && this.entries.size > 0) {
      let oldestKey: string | undefined;
      let oldest: CacheEntry | undefined;
      for (const [key, entry] of this.entries) {
        if (!oldest || entry.lastUsed < oldest.lastUsed) {
          oldestKey = key;
          oldest = entry;
        }
      }
      if (!oldestKey || !oldest) break;
      this.remove(oldestKey, oldest);
    }
  }

  private remove(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }
}
