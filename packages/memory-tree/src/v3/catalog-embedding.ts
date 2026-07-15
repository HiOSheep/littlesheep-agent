// Owns Memory v3 embedding state, bounded rebuild selection, and scoped vector search.

import type { DatabaseSync } from 'node:sqlite';
import type {
  EmbeddingEngine,
  MemoryAtom,
  MemoryCatalogEntry,
  MemoryCatalogSearchOptions,
  MemoryCatalogSearchResult,
} from './contracts.js';
import {
  boundedLimit,
  bufferToVector,
  cosineSimilarity,
  embeddingText,
  rowToEntry,
  scopedAtomQuery,
  vectorToBuffer,
  type AtomRow,
  type VectorRow,
} from './catalog-helpers.js';
import {
  EmbeddingUnavailableError,
  assertEmbeddingPolicy,
  validateEmbeddingResult,
} from './embedding-engine.js';

export interface MemoryCatalogEmbeddingControllerOptions {
  db: DatabaseSync;
  engine?: EmbeddingEngine;
  allowRemote: boolean;
  maxVectorCandidates: number;
}

export class MemoryCatalogEmbeddingController {
  private readonly db: DatabaseSync;
  private readonly engine?: EmbeddingEngine;
  private readonly allowRemote: boolean;
  private readonly maxVectorCandidates: number;

  constructor(options: MemoryCatalogEmbeddingControllerOptions) {
    this.db = options.db;
    this.engine = options.engine;
    this.allowRemote = options.allowRemote;
    this.maxVectorCandidates = options.maxVectorCandidates;
  }

  isConfigured(): boolean {
    return Boolean(this.engine && (this.engine.descriptor.transport !== 'remote' || this.allowRemote));
  }

  async indexAtoms(atoms: MemoryAtom[], signal?: AbortSignal): Promise<MemoryCatalogEntry[]> {
    if (atoms.length === 0) return [];
    const atomIds = atoms.map((atom) => atom.id);
    let engine: EmbeddingEngine | undefined;
    try {
      engine = await this.enabledEngine();
    } catch (error) {
      this.markState(atomIds, this.isConfigured() ? 'pending' : 'disabled');
      throw error;
    }
    if (!engine) {
      this.markState(atomIds, 'disabled');
      return atomIds.map((atomId) => this.requiredAtom(atomId));
    }

    const request = {
      texts: atoms.map((atom) => embeddingText(atom)),
      purpose: 'document' as const,
      signal,
    };
    try {
      const result = await engine.embed(request);
      validateEmbeddingResult(engine, request, result);
      const descriptor = engine.descriptor;
      const timestamp = new Date().toISOString();
      this.transaction(() => {
        const upsertVector = this.db.prepare(`
          INSERT INTO atom_vectors (
            atom_id, engine_id, model_id, engine_version, dimensions,
            embedding, content_hash, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(atom_id) DO UPDATE SET
            engine_id = excluded.engine_id,
            model_id = excluded.model_id,
            engine_version = excluded.engine_version,
            dimensions = excluded.dimensions,
            embedding = excluded.embedding,
            content_hash = excluded.content_hash,
            updated_at = excluded.updated_at
        `);
        const markReady = this.db.prepare(`
          UPDATE atoms SET embedding_status = 'ready', embedding_engine_id = ?,
            embedding_model_id = ?, embedding_dimensions = ?
          WHERE atom_id = ?
        `);
        for (let index = 0; index < atoms.length; index += 1) {
          const atom = atoms[index]!;
          upsertVector.run(
            atom.id,
            descriptor.engineId,
            descriptor.modelId,
            descriptor.version,
            descriptor.dimensions,
            vectorToBuffer(result.vectors[index]!),
            atom.contentHash,
            timestamp,
          );
          markReady.run(descriptor.engineId, descriptor.modelId, descriptor.dimensions, atom.id);
        }
      });
    } catch (error) {
      this.markState(atomIds, 'failed');
      throw error;
    }
    return atomIds.map((atomId) => this.requiredAtom(atomId));
  }

  async search(query: string, options: MemoryCatalogSearchOptions, signal?: AbortSignal): Promise<MemoryCatalogSearchResult[]> {
    const engine = await this.enabledEngine();
    if (!engine) throw new EmbeddingUnavailableError();
    const request = { texts: [query], purpose: 'query' as const, signal };
    const result = await engine.embed(request);
    validateEmbeddingResult(engine, request, result);
    const queryVector = Float32Array.from(result.vectors[0]!);
    const descriptor = engine.descriptor;
    const candidateLimit = Math.min(
      this.maxVectorCandidates,
      Math.max(boundedLimit(options.limit, 20, 200) * 50, 500),
    );
    const { sql, prefixParams } = scopedAtomQuery(options, `
      SELECT a.*, v.embedding
      FROM atoms a
      JOIN atom_vectors v ON v.atom_id = a.atom_id
    `, `a.embedding_status = 'ready' AND v.engine_id = ? AND v.model_id = ? AND v.engine_version = ? AND v.dimensions = ?`, 'a.updated_at DESC', candidateLimit);
    const rows = this.db.prepare(sql).all(
      ...prefixParams,
      descriptor.engineId,
      descriptor.modelId,
      descriptor.version,
      descriptor.dimensions,
    ) as unknown as VectorRow[];
    const scored = rows.map((row) => ({
      entry: rowToEntry(row),
      score: cosineSimilarity(queryVector, bufferToVector(row.embedding)),
      matchReason: 'vector' as const,
    }));
    scored.sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt));
    return scored.slice(0, boundedLimit(options.limit, 20, 200));
  }

  invalidate(): number {
    return Number(this.db.prepare("UPDATE atoms SET embedding_status = 'stale' WHERE embedding_status = 'ready'").run().changes);
  }

  listWork(limit: number): MemoryCatalogEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM atoms
      WHERE status = 'active' AND embedding_status IN ('pending', 'stale', 'failed')
      ORDER BY CASE embedding_status WHEN 'pending' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END,
        updated_at ASC, atom_id ASC
      LIMIT ?
    `).all(limit) as unknown as AtomRow[];
    return rows.map(rowToEntry);
  }

  countWork(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM atoms
      WHERE status = 'active' AND embedding_status IN ('pending', 'stale', 'failed')
    `).get() as { count: number };
    return Number(row.count);
  }

  statusCounts(): Record<MemoryCatalogEntry['embeddingStatus'], number> {
    const counts: Record<MemoryCatalogEntry['embeddingStatus'], number> = {
      disabled: 0, pending: 0, ready: 0, stale: 0, failed: 0,
    };
    const rows = this.db.prepare(`
      SELECT embedding_status, COUNT(*) AS count
      FROM atoms
      WHERE status = 'active'
      GROUP BY embedding_status
    `).all() as Array<{ embedding_status: MemoryCatalogEntry['embeddingStatus']; count: number | bigint }>;
    for (const row of rows) counts[row.embedding_status] = Number(row.count);
    return counts;
  }

  reconcileState(): void {
    if (!this.isConfigured()) {
      this.db.exec(`
        UPDATE atoms SET embedding_status = 'disabled', embedding_engine_id = NULL,
          embedding_model_id = NULL, embedding_dimensions = NULL
      `);
      return;
    }
    const descriptor = this.engine!.descriptor;
    this.db.exec(`UPDATE atoms SET embedding_status = 'pending' WHERE embedding_status = 'disabled'`);
    this.db.prepare(`
      UPDATE atoms SET embedding_status = 'stale'
      WHERE embedding_status = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM atom_vectors vector
          WHERE vector.atom_id = atoms.atom_id
            AND vector.engine_id = ?
            AND vector.model_id = ?
            AND vector.engine_version = ?
            AND vector.dimensions = ?
            AND vector.content_hash = atoms.content_hash
        )
    `).run(descriptor.engineId, descriptor.modelId, descriptor.version, descriptor.dimensions);
  }

  private async enabledEngine(): Promise<EmbeddingEngine | undefined> {
    if (!this.engine) return undefined;
    assertEmbeddingPolicy(this.engine, this.allowRemote);
    if (!await this.engine.isAvailable()) {
      throw new EmbeddingUnavailableError('The configured embedding engine is not currently available.');
    }
    return this.engine;
  }

  private markState(atomIds: string[], status: 'disabled' | 'pending' | 'failed'): void {
    const update = this.db.prepare(`
      UPDATE atoms SET embedding_status = ?, embedding_engine_id = NULL,
        embedding_model_id = NULL, embedding_dimensions = NULL
      WHERE atom_id = ?
    `);
    this.transaction(() => {
      for (const atomId of atomIds) update.run(status, atomId);
    });
  }

  private requiredAtom(atomId: string): MemoryCatalogEntry {
    const row = this.db.prepare('SELECT * FROM atoms WHERE atom_id = ?').get(atomId) as unknown as AtomRow | undefined;
    if (!row) throw new Error(`Memory atom is not registered in catalog: ${atomId}`);
    return rowToEntry(row);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
