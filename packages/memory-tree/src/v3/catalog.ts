// Owns the rebuildable Memory v3 SQLite catalog facade and its bounded projections.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  EmbeddingEngine,
  MemoryAccessRecord,
  MemoryAtom,
  MemoryCatalogEntry,
  MemoryCatalogSearchOptions,
  MemoryCatalogSearchResult,
  MemoryDueRecord,
  MemoryEntity,
  MemoryEventJournalRecord,
  MemoryOperationRecord,
  MemoryRelation,
  MemoryUseFeedback,
} from './contracts.js';
import { MEMORY_CATALOG_SCHEMA_SQL, MEMORY_CATALOG_SCHEMA_VERSION } from './catalog-schema.js';
import { upsertMemoryEntity, upsertMemoryRelation } from './catalog-graph.js';
import {
  assertScope,
  boundedLimit,
  bufferToVector,
  cosineSimilarity,
  embeddingText,
  positiveLimit,
  pruneTable,
  rowToEntry,
  scalarCount,
  scopedAtomQuery,
  toFtsQuery,
  vectorToBuffer,
  type AtomRow,
  type VectorRow,
} from './catalog-helpers.js';
import {
  EmbeddingUnavailableError,
  assertEmbeddingPolicy,
  validateEmbeddingResult,
} from './embedding-engine.js';
import { memoryAtomContentHash } from './atom-store.js';
import { parseMemoryAtom, validateMemoryUseFeedback } from './validation.js';

const DEFAULT_MAX_ACCESS_RECORDS = 20_000;
const DEFAULT_MAX_FEEDBACK_RECORDS = 10_000;
const DEFAULT_MAX_AUDIT_RECORDS = 20_000;
const DEFAULT_VECTOR_CANDIDATES = 10_000;

export interface MemoryCatalogOptions {
  dataDir: string;
  dbPath?: string;
  embeddingEngine?: EmbeddingEngine;
  allowRemoteEmbedding?: boolean;
  maxAccessRecords?: number;
  maxFeedbackRecords?: number;
  maxAuditRecords?: number;
  maxVectorCandidates?: number;
}

export interface MemoryCatalogRebuildItem {
  atom: MemoryAtom;
  filePath: string;
}

export class MemoryCatalog {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly embeddingEngine?: EmbeddingEngine;
  private readonly allowRemoteEmbedding: boolean;
  private readonly maxAccessRecords: number;
  private readonly maxFeedbackRecords: number;
  private readonly maxAuditRecords: number;
  private readonly maxVectorCandidates: number;

  constructor(options: MemoryCatalogOptions) {
    this.dbPath = options.dbPath ?? join(options.dataDir, 'memory-tree', 'v3', 'catalog.sqlite');
    this.embeddingEngine = options.embeddingEngine;
    this.allowRemoteEmbedding = options.allowRemoteEmbedding ?? false;
    this.maxAccessRecords = positiveLimit(options.maxAccessRecords, DEFAULT_MAX_ACCESS_RECORDS);
    this.maxFeedbackRecords = positiveLimit(options.maxFeedbackRecords, DEFAULT_MAX_FEEDBACK_RECORDS);
    this.maxAuditRecords = positiveLimit(options.maxAuditRecords, DEFAULT_MAX_AUDIT_RECORDS);
    this.maxVectorCandidates = positiveLimit(options.maxVectorCandidates, DEFAULT_VECTOR_CANDIDATES);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(MEMORY_CATALOG_SCHEMA_SQL);
    this.db.exec(`PRAGMA user_version = ${MEMORY_CATALOG_SCHEMA_VERSION};`);
    this.reconcileEmbeddingState();
  }

  upsertAtom(atom: MemoryAtom, filePath: string): MemoryCatalogEntry {
    const verified = this.verifyAtom(atom);
    this.transaction(() => this.upsertAtomInTransaction(verified, filePath));
    return this.getAtom(verified.id)!;
  }

  getAtom(atomId: string): MemoryCatalogEntry | undefined {
    const row = this.db.prepare('SELECT * FROM atoms WHERE atom_id = ?').get(atomId) as unknown as AtomRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  listChildren(parentId: string, options: Pick<MemoryCatalogSearchOptions, 'branch' | 'scope' | 'scopeKey' | 'includeArchived'>): MemoryCatalogEntry[] {
    assertScope(options);
    const rows = this.db.prepare(`
      SELECT * FROM atoms
      WHERE parent_id = ? AND branch = ? AND scope = ? AND scope_key IS ?
        ${options.includeArchived ? '' : "AND status = 'active'"}
      ORDER BY updated_at DESC, atom_id ASC
    `).all(parentId, options.branch, options.scope, options.scopeKey ?? null) as unknown as AtomRow[];
    return rows.map(rowToEntry);
  }

  searchFts(query: string, options: MemoryCatalogSearchOptions): MemoryCatalogSearchResult[] {
    assertScope(options);
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    const limit = boundedLimit(options.limit, 20, 200);
    const { sql, prefixParams } = scopedAtomQuery(options, `
      SELECT a.*, bm25(atom_fts) AS fts_rank
      FROM atom_fts
      JOIN atoms a ON a.atom_id = atom_fts.atom_id
    `, `atom_fts MATCH ?`, 'fts_rank ASC, a.updated_at DESC', limit);
    const rows = this.db.prepare(sql).all(...prefixParams, ftsQuery) as unknown as Array<AtomRow & { fts_rank: number }>;
    return rows.map((row) => ({
      entry: rowToEntry(row),
      score: 1 / (1 + Math.abs(Number(row.fts_rank))),
      matchReason: 'fts',
    }));
  }

  async indexEmbedding(atom: MemoryAtom, signal?: AbortSignal): Promise<MemoryCatalogEntry> {
    const verified = this.verifyAtom(atom);
    let engine: EmbeddingEngine | undefined;
    try {
      engine = await this.enabledEmbeddingEngine();
    } catch (error) {
      this.markEmbeddingDisabled(verified.id);
      throw error;
    }
    if (!engine) {
      this.markEmbeddingDisabled(verified.id);
      const entry = this.getAtom(verified.id);
      if (!entry) throw new Error(`Memory atom is not registered in catalog: ${verified.id}`);
      return entry;
    }
    const request = { texts: [embeddingText(verified)], signal };
    try {
      const result = await engine.embed(request);
      validateEmbeddingResult(engine, request, result);
      const vector = result.vectors[0]!;
      const descriptor = engine.descriptor;
      const timestamp = new Date().toISOString();
      this.transaction(() => {
        this.db.prepare(`
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
        `).run(
          verified.id,
          descriptor.engineId,
          descriptor.modelId,
          descriptor.version,
          descriptor.dimensions,
          vectorToBuffer(vector),
          verified.contentHash,
          timestamp,
        );
        this.db.prepare(`
          UPDATE atoms SET embedding_status = 'ready', embedding_engine_id = ?,
            embedding_model_id = ?, embedding_dimensions = ?
          WHERE atom_id = ?
        `).run(descriptor.engineId, descriptor.modelId, descriptor.dimensions, verified.id);
      });
    } catch (error) {
      this.db.prepare("UPDATE atoms SET embedding_status = 'failed' WHERE atom_id = ?").run(verified.id);
      throw error;
    }
    return this.getAtom(verified.id)!;
  }

  async searchVector(query: string, options: MemoryCatalogSearchOptions): Promise<MemoryCatalogSearchResult[]> {
    assertScope(options);
    const engine = await this.enabledEmbeddingEngine();
    if (!engine) throw new EmbeddingUnavailableError();
    const request = { texts: [query] };
    const result = await engine.embed(request);
    validateEmbeddingResult(engine, request, result);
    const queryVector = Float32Array.from(result.vectors[0]!);
    const descriptor = engine.descriptor;
    const candidateLimit = Math.min(this.maxVectorCandidates, Math.max(boundedLimit(options.limit, 20, 200) * 50, 500));
    const { sql, prefixParams } = scopedAtomQuery(options, `
      SELECT a.*, v.embedding
      FROM atoms a
      JOIN atom_vectors v ON v.atom_id = a.atom_id
    `, `v.engine_id = ? AND v.model_id = ? AND v.engine_version = ? AND v.dimensions = ?`, 'a.updated_at DESC', candidateLimit);
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

  invalidateEmbeddings(): number {
    return Number(this.db.prepare("UPDATE atoms SET embedding_status = 'stale' WHERE embedding_status = 'ready'").run().changes);
  }

  rebuild(items: MemoryCatalogRebuildItem[]): number {
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM atom_fts;
        DELETE FROM atom_vectors;
        DELETE FROM memory_due;
        DELETE FROM atoms;
      `);
      for (const item of items) this.upsertAtomInTransaction(this.verifyAtom(item.atom), item.filePath);
    });
    return items.length;
  }

  async rebuildFrom(items: AsyncIterable<MemoryCatalogRebuildItem>): Promise<number> {
    this.db.exec('BEGIN IMMEDIATE');
    let count = 0;
    try {
      this.db.exec(`
        DELETE FROM atom_fts;
        DELETE FROM atom_vectors;
        DELETE FROM memory_due;
        DELETE FROM atoms;
      `);
      for await (const item of items) {
        this.upsertAtomInTransaction(this.verifyAtom(item.atom), item.filePath);
        count += 1;
      }
      this.db.exec('COMMIT');
      return count;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordAccess(record: MemoryAccessRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO atom_access (
        id, atom_id, run_id, stage, retrieval_path, match_reason,
        entered_context, disclosure_level, tokens_used, accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.atomId,
      record.runId,
      record.stage,
      record.path,
      record.matchReason,
      record.enteredContext ? 1 : 0,
      record.disclosureLevel,
      Math.max(0, Math.floor(record.tokensUsed)),
      record.accessedAt,
    );
    pruneTable(this.db, 'atom_access', 'id', 'accessed_at', this.maxAccessRecords);
  }

  recordFeedback(feedback: MemoryUseFeedback): void {
    validateMemoryUseFeedback(feedback);
    this.db.prepare(`
      INSERT OR REPLACE INTO atom_feedback (
        id, atom_id, run_id, outcome, verified, evidence_refs,
        verify_stage_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      feedback.id,
      feedback.atomId,
      feedback.runId,
      feedback.outcome,
      feedback.verified ? 1 : 0,
      JSON.stringify(feedback.evidenceRefs),
      feedback.verifyStageId ?? null,
      feedback.reason,
      feedback.createdAt,
    );
    pruneTable(this.db, 'atom_feedback', 'id', 'created_at', this.maxFeedbackRecords);
  }

  countAccessRecords(): number {
    return scalarCount(this.db, 'atom_access');
  }

  countFeedbackRecords(): number {
    return scalarCount(this.db, 'atom_feedback');
  }

  projectEvent(record: MemoryEventJournalRecord): void {
    const event = record.event;
    this.db.prepare(`
      INSERT INTO memory_events (
        event_id, idempotency_key, event_kind, atom_id, state, attempts,
        occurred_at, observed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        state = excluded.state,
        attempts = excluded.attempts,
        atom_id = excluded.atom_id,
        updated_at = excluded.updated_at
    `).run(
      event.id,
      event.idempotencyKey,
      event.kind,
      event.atomId ?? null,
      record.state,
      record.attempts,
      event.occurredAt,
      event.observedAt,
      record.updatedAt,
    );
  }

  projectOperation(record: MemoryOperationRecord): void {
    this.db.prepare(`
      INSERT INTO operations (
        operation_id, idempotency_key, operation_kind, state, atom_ids_json,
        event_ids_json, expected_revisions_json, attempts, last_error,
        started_at, updated_at, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET
        state = excluded.state,
        attempts = excluded.attempts,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at,
        committed_at = excluded.committed_at
    `).run(
      record.id,
      record.idempotencyKey,
      record.kind,
      record.state,
      JSON.stringify(record.atomIds),
      JSON.stringify(record.eventIds),
      JSON.stringify(record.expectedRevisions),
      record.attempts,
      record.lastError ?? null,
      record.startedAt,
      record.updatedAt,
      record.committedAt ?? null,
    );
  }

  replaceDueRecords(atomId: string, records: MemoryDueRecord[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM memory_due WHERE atom_id = ?').run(atomId);
      const insert = this.db.prepare('INSERT INTO memory_due (atom_id, due_kind, due_at) VALUES (?, ?, ?)');
      for (const record of records) {
        if (record.atomId !== atomId) throw new Error('Memory due record atomId does not match replacement target.');
        insert.run(record.atomId, record.kind, record.dueAt);
      }
    });
  }

  listDue(now: string, limit = 100): MemoryDueRecord[] {
    const rows = this.db.prepare(`
      SELECT atom_id, due_kind, due_at FROM memory_due
      WHERE due_at <= ? ORDER BY due_at ASC LIMIT ?
    `).all(now, boundedLimit(limit, 100, 1_000)) as unknown as Array<{
      atom_id: string;
      due_kind: MemoryDueRecord['kind'];
      due_at: string;
    }>;
    return rows.map((row) => ({ atomId: row.atom_id, kind: row.due_kind, dueAt: row.due_at }));
  }

  upsertEntity(entity: MemoryEntity): void {
    upsertMemoryEntity(this.db, entity);
  }

  upsertRelation(relation: MemoryRelation): void {
    upsertMemoryRelation(this.db, relation);
  }

  audit(action: string, detail: Record<string, unknown>, atomId?: string, operationId?: string): void {
    this.db.prepare(`
      INSERT INTO audit (id, action, atom_id, operation_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), action, atomId ?? null, operationId ?? null, JSON.stringify(detail), new Date().toISOString());
    pruneTable(this.db, 'audit', 'id', 'created_at', this.maxAuditRecords);
  }

  countAtoms(): number {
    return scalarCount(this.db, 'atoms');
  }

  integrityCheck(): string {
    const row = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    return row.integrity_check;
  }

  close(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    this.db.close();
  }

  private upsertAtomInTransaction(atom: MemoryAtom, filePath: string): void {
    const existing = this.db.prepare('SELECT content_hash, embedding_status FROM atoms WHERE atom_id = ?')
      .get(atom.id) as { content_hash: string; embedding_status: string } | undefined;
    const contentChanged = existing?.content_hash !== atom.contentHash;
    const embeddingConfigured = this.embeddingIsConfigured();
    const embeddingStatus = !embeddingConfigured
      ? 'disabled'
      : contentChanged
        ? 'pending'
        : existing?.embedding_status === 'ready' || existing?.embedding_status === 'stale'
          ? existing.embedding_status
          : 'pending';
    if (contentChanged) this.db.prepare('DELETE FROM atom_vectors WHERE atom_id = ?').run(atom.id);
    this.db.prepare(`
      INSERT INTO atoms (
        atom_id, file_path, revision, domain, branch, parent_id, scope, scope_key,
        tier, statement_kind, epistemic_status, status, resolution_status,
        title, summary, content_hash, embedding_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(atom_id) DO UPDATE SET
        file_path = excluded.file_path,
        revision = excluded.revision,
        domain = excluded.domain,
        branch = excluded.branch,
        parent_id = excluded.parent_id,
        scope = excluded.scope,
        scope_key = excluded.scope_key,
        tier = excluded.tier,
        statement_kind = excluded.statement_kind,
        epistemic_status = excluded.epistemic_status,
        status = excluded.status,
        resolution_status = excluded.resolution_status,
        title = excluded.title,
        summary = excluded.summary,
        content_hash = excluded.content_hash,
        embedding_status = excluded.embedding_status,
        embedding_engine_id = CASE WHEN excluded.embedding_status IN ('ready', 'stale') THEN atoms.embedding_engine_id ELSE NULL END,
        embedding_model_id = CASE WHEN excluded.embedding_status IN ('ready', 'stale') THEN atoms.embedding_model_id ELSE NULL END,
        embedding_dimensions = CASE WHEN excluded.embedding_status IN ('ready', 'stale') THEN atoms.embedding_dimensions ELSE NULL END,
        updated_at = excluded.updated_at
    `).run(
      atom.id,
      filePath,
      atom.revision,
      atom.domain,
      atom.branch,
      atom.parentId ?? null,
      atom.scope,
      atom.scopeKey ?? null,
      atom.tier,
      atom.statementKind,
      atom.epistemicStatus,
      atom.status,
      atom.resolutionStatus,
      atom.title,
      atom.summary,
      atom.contentHash,
      embeddingStatus,
      atom.createdAt,
      atom.updatedAt,
    );
    this.db.prepare('DELETE FROM atom_fts WHERE atom_id = ?').run(atom.id);
    this.db.prepare(`
      INSERT INTO atom_fts (atom_id, title, summary, content, retrieval_keys)
      VALUES (?, ?, ?, ?, ?)
    `).run(atom.id, atom.title, atom.summary, atom.content, atom.retrievalKeys.join(' '));
    this.replaceAtomDueRecords(atom);
  }

  private replaceAtomDueRecords(atom: MemoryAtom): void {
    this.db.prepare('DELETE FROM memory_due WHERE atom_id = ?').run(atom.id);
    const insert = this.db.prepare('INSERT INTO memory_due (atom_id, due_kind, due_at) VALUES (?, ?, ?)');
    if (atom.effectiveAt) insert.run(atom.id, 'effective', atom.effectiveAt);
    if (atom.expiresAt) insert.run(atom.id, 'expiry', atom.expiresAt);
    if (atom.revalidateAt) insert.run(atom.id, 'revalidate', atom.revalidateAt);
  }

  private async enabledEmbeddingEngine(): Promise<EmbeddingEngine | undefined> {
    if (!this.embeddingEngine) return undefined;
    assertEmbeddingPolicy(this.embeddingEngine, this.allowRemoteEmbedding);
    return await this.embeddingEngine.isAvailable() ? this.embeddingEngine : undefined;
  }

  private verifyAtom(atom: MemoryAtom): MemoryAtom {
    const verified = parseMemoryAtom(structuredClone(atom));
    if (memoryAtomContentHash(verified) !== verified.contentHash) {
      throw new Error(`Memory atom content hash mismatch: ${verified.id}`);
    }
    return verified;
  }

  private embeddingIsConfigured(): boolean {
    return Boolean(this.embeddingEngine
      && (this.embeddingEngine.descriptor.transport !== 'remote' || this.allowRemoteEmbedding));
  }

  private reconcileEmbeddingState(): void {
    if (!this.embeddingIsConfigured()) {
      this.db.exec(`
        UPDATE atoms SET embedding_status = 'disabled', embedding_engine_id = NULL,
          embedding_model_id = NULL, embedding_dimensions = NULL
      `);
      return;
    }
    const descriptor = this.embeddingEngine!.descriptor;
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

  private markEmbeddingDisabled(atomId: string): void {
    this.db.prepare(`
      UPDATE atoms SET embedding_status = 'disabled', embedding_engine_id = NULL,
        embedding_model_id = NULL, embedding_dimensions = NULL
      WHERE atom_id = ?
    `).run(atomId);
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
