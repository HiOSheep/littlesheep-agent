// @littlesheep/vector — vector-store.ts
// SQLite-backed vector store with JS cosine similarity search.
//
// Uses Node's built-in `node:sqlite` module (Node 22.5+, no native deps).
// Embeddings are stored as Float32Array BLOBs; search embeds the query via
// the LLM client, scans candidate rows (filtered by tier/date), and ranks by
// cosine similarity. For <10k records this completes in <10ms — sufficient
// for personal agent memory scale.
//
// Future optimization: load the sqlite-vec extension for native KNN search
// when record count exceeds ~10k. The interface stays the same.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import type { LlmClient } from '@littlesheep/llm';
import type {
  VectorInsert,
  VectorRecord,
  VectorSearchFilter,
  VectorSearchResult,
  VectorStoreOptions,
  VectorTier,
} from './types.js';

// ─── Schema ──────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_vectors (
  id         TEXT PRIMARY KEY,
  embedding  BLOB NOT NULL,
  text       TEXT NOT NULL,
  tier       TEXT NOT NULL,
  date       TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vec_tier   ON memory_vectors(tier);
CREATE INDEX IF NOT EXISTS idx_vec_source ON memory_vectors(source);
CREATE INDEX IF NOT EXISTS idx_vec_date   ON memory_vectors(date);
`;

interface Row {
  id: string;
  embedding: Uint8Array;
  text: string;
  tier: string;
  date: string;
  source: string;
  created_at: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Convert a number[] to a Buffer for BLOB storage. */
function toBuffer(vec: number[]): Buffer {
  const arr = new Float32Array(vec);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Convert a BLOB (Uint8Array/Buffer) back to a Float32Array. */
function fromBuffer(buf: Uint8Array): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Cosine similarity between two vectors (0-1, higher = more similar). */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function rowToRecord(row: Row): VectorRecord {
  return {
    id: row.id,
    text: row.text,
    tier: row.tier as VectorTier,
    date: row.date,
    source: row.source,
    createdAt: row.created_at,
  };
}

// ─── VectorStore ─────────────────────────────────────────────────────────

export class VectorStore {
  private readonly db: DatabaseSync;
  private readonly embeddingModel: string;
  private readonly dimensions: number;
  private readonly llm: LlmClient;

  // Prepared statements (reused compiled plans).
  private readonly stmtInsert: StatementSync;
  private readonly stmtDeleteById: StatementSync;
  private readonly stmtDeleteBySource: StatementSync;
  private readonly stmtCount: StatementSync;
  private readonly stmtCountByTier: StatementSync;

  constructor(opts: VectorStoreOptions) {
    this.embeddingModel = opts.embeddingModel;
    this.dimensions = opts.dimensions;
    this.llm = opts.llm;

    // Ensure parent directory exists.
    mkdirSync(dirname(opts.dbPath), { recursive: true });

    this.db = new DatabaseSync(opts.dbPath);
    // Wait up to 5s for locks (e.g. another process shutting down) instead of
    // immediately throwing "disk I/O error" on the -shm file. Critical for
    // Electron dev restarts where the old process may still hold the WAL lock.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA_SQL);

    this.stmtInsert = this.db.prepare(
      'INSERT INTO memory_vectors (id, embedding, text, tier, date, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.stmtDeleteById = this.db.prepare('DELETE FROM memory_vectors WHERE id = ?');
    this.stmtDeleteBySource = this.db.prepare('DELETE FROM memory_vectors WHERE source = ?');
    this.stmtCount = this.db.prepare('SELECT COUNT(*) as n FROM memory_vectors');
    this.stmtCountByTier = this.db.prepare('SELECT COUNT(*) as n FROM memory_vectors WHERE tier = ?');
  }

  /** Generate an embedding for a single text via the LLM client. */
  private async embed(text: string): Promise<number[]> {
    const res = await this.llm.embed({
      model: this.embeddingModel,
      input: text,
      dimensions: this.dimensions,
    });
    return res.embeddings[0]!;
  }

  /** Generate embeddings for a batch of texts (single API call). */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await this.llm.embed({
      model: this.embeddingModel,
      input: texts,
      dimensions: this.dimensions,
    });
    return res.embeddings;
  }

  /** Insert a single record. Returns the generated id. */
  async insert(record: VectorInsert): Promise<string> {
    const embedding = await this.embed(record.text);
    const id = randomUUID();
    const createdAt = Date.now();
    this.stmtInsert.run(
      id,
      toBuffer(embedding),
      record.text,
      record.tier,
      record.date,
      record.source,
      createdAt,
    );
    return id;
  }

  /** Insert a batch of records (single embeddings API call). Returns generated ids. */
  async insertBatch(records: VectorInsert[]): Promise<string[]> {
    if (records.length === 0) return [];
    const texts = records.map((r) => r.text);
    const embeddings = await this.embedBatch(texts);
    const createdAt = Date.now();
    const ids: string[] = [];
    // Manual transaction (node:sqlite has no db.transaction() helper).
    this.db.exec('BEGIN');
    try {
      for (let i = 0; i < records.length; i++) {
        const rec = records[i]!;
        const emb = embeddings[i]!;
        const id = randomUUID();
        this.stmtInsert.run(
          id,
          toBuffer(emb),
          rec.text,
          rec.tier,
          rec.date,
          rec.source,
          createdAt,
        );
        ids.push(id);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return ids;
  }

  /**
   * Semantic search: embed the query, scan candidate rows (filtered by
   * tier/date), rank by cosine similarity, return top-K.
   */
  async search(
    query: string,
    limit: number = 20,
    filter?: VectorSearchFilter,
  ): Promise<VectorSearchResult[]> {
    const queryEmb = fromBuffer(toBuffer(await this.embed(query)));

    // Build the candidate query with optional filters.
    let sql = 'SELECT * FROM memory_vectors';
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter?.tiers && filter.tiers.length > 0) {
      const placeholders = filter.tiers.map(() => '?').join(',');
      conditions.push(`tier IN (${placeholders})`);
      params.push(...filter.tiers);
    }
    if (filter?.since) {
      conditions.push('date >= ?');
      params.push(filter.since);
    }
    if (filter?.until) {
      conditions.push('date <= ?');
      params.push(filter.until);
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    const rows = this.db.prepare(sql).all(...params) as unknown as Row[];

    // Compute similarity + rank.
    const scored = rows.map((row) => {
      const emb = fromBuffer(row.embedding);
      return { record: rowToRecord(row), score: cosineSimilarity(queryEmb, emb) };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => ({ ...s.record, score: s.score }));
  }

  /** Remove a single record by id. Returns number of rows deleted (0 or 1). */
  remove(id: string): number {
    return Number(this.stmtDeleteById.run(id).changes);
  }

  /** Remove all records matching a source file path. Returns count deleted. */
  removeBySource(source: string): number {
    return Number(this.stmtDeleteBySource.run(source).changes);
  }

  /**
   * Remove records matching a tier and optional date range.
   * `since`/`until` compare lexicographically on the `date` string.
   */
  removeByTierAndDateRange(tier: VectorTier, since?: string, until?: string): number {
    const conditions: string[] = ['tier = ?'];
    const params: SQLInputValue[] = [tier];
    if (since) {
      conditions.push('date >= ?');
      params.push(since);
    }
    if (until) {
      conditions.push('date <= ?');
      params.push(until);
    }
    const sql = `DELETE FROM memory_vectors WHERE ${conditions.join(' AND ')}`;
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  /** List all records of a given tier (without embeddings). */
  listByTier(tier: VectorTier): VectorRecord[] {
    const rows = this.db.prepare(
      'SELECT id, text, tier, date, source, created_at FROM memory_vectors WHERE tier = ? ORDER BY date DESC',
    ).all(tier) as unknown as Omit<Row, 'embedding'>[];
    return rows.map((r) => rowToRecord({ ...r, embedding: new Uint8Array() }));
  }

  /** Total record count. */
  count(): number {
    return Number((this.stmtCount.get() as { n: number | bigint }).n);
  }

  /** Count records in a specific tier. */
  countByTier(tier: VectorTier): number {
    return Number((this.stmtCountByTier.get(tier) as { n: number | bigint }).n);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
