// Owns the rebuildable Memory v3 SQLite catalog facade and its bounded projections.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  EmbeddingEngine,
  MemoryAccessRecord,
  MemoryAtom,
  MemoryAtomHistoryEntry,
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
import {
  getMemoryEntity,
  memoryEntityReferenceBlockers,
  memoryRelationReferenceBlockers,
  upsertMemoryEntity,
  upsertMemoryRelation,
  type MemoryEntityReferenceBlockers,
  type MemoryRelationReferenceBlockers,
} from './catalog-graph.js';
import {
  assertScope,
  boundedLimit,
  memoryAtomEmbeddingHash,
  positiveLimit,
  pruneTable,
  rowToEntry,
  scalarCount,
  scopedAtomQuery,
  type AtomRow,
} from './catalog-helpers.js';
import {
  MemoryCatalogEmbeddingController,
  type PreparedMemoryVectorQuery,
} from './catalog-embedding.js';
import { listMemoryAtomHistory } from './catalog-history.js';
import { upgradeMemoryCatalogSchema } from './catalog-migrations.js';
import { aggregateRelationRelevance } from './catalog-relevance.js';
import { replaceAtomDueRecords, replaceAtomGraphReferences } from './catalog-atom-projection.js';
import {
  listRelationRoutingCandidates,
  type MemoryRelationRoutingCandidate,
  type MemoryRelationRoutingOptions,
} from './catalog-relation-routing.js';
import { searchMemoryCatalogFts } from './catalog-fts.js';
import { memoryAtomContentHash } from './atom-store.js';
import { memoryAtomActivation } from './activation.js';
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

export interface MemoryCatalogListOptions {
  branch?: MemoryAtom['branch'];
  scope?: MemoryAtom['scope'];
  scopeKey?: string;
  status?: MemoryAtom['status'];
  limit?: number;
  orderBy?: 'updated' | 'activation';
}

export class MemoryCatalog {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly embeddings: MemoryCatalogEmbeddingController;
  private readonly maxAccessRecords: number;
  private readonly maxFeedbackRecords: number;
  private readonly maxAuditRecords: number;

  constructor(options: MemoryCatalogOptions) {
    this.dbPath = options.dbPath ?? join(options.dataDir, 'memory-tree', 'v3', 'catalog.sqlite');
    this.maxAccessRecords = positiveLimit(options.maxAccessRecords, DEFAULT_MAX_ACCESS_RECORDS);
    this.maxFeedbackRecords = positiveLimit(options.maxFeedbackRecords, DEFAULT_MAX_FEEDBACK_RECORDS);
    this.maxAuditRecords = positiveLimit(options.maxAuditRecords, DEFAULT_MAX_AUDIT_RECORDS);
    const maxVectorCandidates = positiveLimit(options.maxVectorCandidates, DEFAULT_VECTOR_CANDIDATES);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(MEMORY_CATALOG_SCHEMA_SQL);
    upgradeMemoryCatalogSchema(this.db);
    this.db.exec(`PRAGMA user_version = ${MEMORY_CATALOG_SCHEMA_VERSION};`);
    this.embeddings = new MemoryCatalogEmbeddingController({
      db: this.db,
      engine: options.embeddingEngine,
      allowRemote: options.allowRemoteEmbedding ?? false,
      maxVectorCandidates,
    });
    this.embeddings.reconcileState();
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

  listAtoms(options: MemoryCatalogListOptions = {}): MemoryCatalogEntry[] {
    if (options.scope) assertScope({ scope: options.scope, scopeKey: options.scopeKey });
    else if (options.scopeKey !== undefined) throw new Error('Memory catalog scopeKey requires an explicit scope.');
    const where: string[] = [];
    const params: Array<string | null> = [];
    if (options.branch) {
      where.push('branch = ?');
      params.push(options.branch);
    }
    if (options.scope) {
      where.push('scope = ?');
      params.push(options.scope);
      where.push('scope_key IS ?');
      params.push(options.scopeKey ?? null);
    }
    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    const orderBy = options.orderBy === 'activation'
      ? 'activation_score DESC, activation_updated_at DESC, updated_at DESC, atom_id ASC'
      : 'updated_at DESC, atom_id ASC';
    const rows = this.db.prepare(`
      SELECT * FROM atoms ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${orderBy} LIMIT ?
    `).all(...params, boundedLimit(options.limit, 1_000, 100_000)) as unknown as AtomRow[];
    return rows.map(rowToEntry);
  }

  listChildrenByParent(parentId: string, includeInactive = false): MemoryCatalogEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM atoms WHERE parent_id = ? ${includeInactive ? '' : "AND status = 'active'"}
      ORDER BY updated_at DESC, atom_id ASC
    `).all(parentId) as unknown as AtomRow[];
    return rows.map(rowToEntry);
  }

  hasActiveChildren(parentId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM atoms WHERE parent_id = ? AND status = 'active' LIMIT 1").get(parentId) as { present?: number } | undefined;
    return row?.present === 1;
  }

  countActiveDescendants(parentId: string, limit = 129): number {
    const bounded = boundedLimit(limit, 129, 100_000);
    const row = this.db.prepare(`
      WITH RECURSIVE active_descendants(atom_id) AS (
        SELECT atom_id FROM atoms WHERE parent_id = ? AND status = 'active'
        UNION
        SELECT child.atom_id
        FROM atoms child
        JOIN active_descendants parent ON child.parent_id = parent.atom_id
        WHERE child.status = 'active'
        LIMIT ?
      )
      SELECT COUNT(*) AS count FROM active_descendants
    `).get(parentId, bounded) as { count?: number | bigint } | undefined;
    return Number(row?.count ?? 0);
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

  relationRelevanceForAtoms(atomIds: readonly string[], now: string): Map<string, number> {
    return aggregateRelationRelevance(this.db, atomIds, now);
  }

  listRelationRoutingCandidates(
    seedAtomIds: readonly string[],
    options: MemoryRelationRoutingOptions,
    now: string,
  ): MemoryRelationRoutingCandidate[] {
    return listRelationRoutingCandidates(this.db, seedAtomIds, options, now);
  }

  searchFts(query: string, options: MemoryCatalogSearchOptions): MemoryCatalogSearchResult[] {
    assertScope(options);
    return searchMemoryCatalogFts(this.db, query, options);
  }

  async indexEmbedding(atom: MemoryAtom, signal?: AbortSignal): Promise<MemoryCatalogEntry> {
    const entries = await this.indexEmbeddings([atom], signal);
    return entries[0]!;
  }

  async indexEmbeddings(atoms: MemoryAtom[], signal?: AbortSignal): Promise<MemoryCatalogEntry[]> {
    const verifiedAtoms = atoms.map((atom) => this.verifyAtom(atom));
    return this.embeddings.indexAtoms(verifiedAtoms, signal);
  }

  async searchVector(query: string, options: MemoryCatalogSearchOptions, signal?: AbortSignal): Promise<MemoryCatalogSearchResult[]> {
    assertScope(options);
    return this.embeddings.search(query, options, signal);
  }

  prepareVectorQuery(query: string, signal?: AbortSignal): Promise<PreparedMemoryVectorQuery> { return this.embeddings.prepareQuery(query, signal); }

  searchPreparedVector(
    prepared: PreparedMemoryVectorQuery,
    options: MemoryCatalogSearchOptions,
  ): MemoryCatalogSearchResult[] { assertScope(options); return this.embeddings.searchPrepared(prepared, options); }

  invalidateEmbeddings(): number {
    return this.embeddings.invalidate();
  }

  listEmbeddingWork(limit = 100): MemoryCatalogEntry[] {
    return this.embeddings.listWork(boundedLimit(limit, 100, 1_000));
  }

  countEmbeddingWork(): number {
    return this.embeddings.countWork();
  }
  embeddingStatusCounts(): Record<MemoryCatalogEntry['embeddingStatus'], number> { return this.embeddings.statusCounts(); }
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
    this.recordAccessBatch([record]);
  }

  recordAccessBatch(records: MemoryAccessRecord[]): void {
    if (records.length === 0) return;
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO atom_access (
        id, atom_id, run_id, stage, retrieval_path, match_reason,
        entered_context, disclosure_level, tokens_used, accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const record of records) {
        insert.run(
          record.id, record.atomId, record.runId, record.stage, record.path,
          record.matchReason, record.enteredContext ? 1 : 0, record.disclosureLevel,
          Math.max(0, Math.floor(record.tokensUsed)), record.accessedAt,
        );
      }
      pruneTable(this.db, 'atom_access', 'id', 'accessed_at', this.maxAccessRecords);
    });
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

  hasFeedback(feedbackId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS found FROM atom_feedback WHERE id = ?').get(feedbackId));
  }

  listAtomHistory(atomId: string, limit = 40): MemoryAtomHistoryEntry[] {
    return listMemoryAtomHistory(this.db, atomId, limit);
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

  knownEventIds(eventIds: readonly string[]): Set<string> {
    const ids = [...new Set(eventIds)].slice(0, 500);
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT event_id FROM memory_events WHERE event_id IN (${placeholders})`)
      .all(...ids) as unknown as Array<{ event_id: string }>;
    return new Set(rows.map((row) => row.event_id));
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
      SELECT due.atom_id, due.due_kind, due.due_at FROM memory_due due
      JOIN atoms atom ON atom.atom_id = due.atom_id
      WHERE atom.status = 'active' AND due.due_at <= ?
      ORDER BY due.due_at ASC, due.atom_id ASC LIMIT ?
    `).all(now, boundedLimit(limit, 100, 1_000)) as unknown as Array<{
      atom_id: string;
      due_kind: MemoryDueRecord['kind'];
      due_at: string;
    }>;
    return rows.map((row) => ({ atomId: row.atom_id, kind: row.due_kind, dueAt: row.due_at }));
  }

  acknowledgeDue(record: MemoryDueRecord): boolean {
    return Number(this.db.prepare(`
      DELETE FROM memory_due WHERE atom_id = ? AND due_kind = ? AND due_at = ?
    `).run(record.atomId, record.kind, record.dueAt).changes) > 0;
  }

  countDue(now: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM memory_due due
      JOIN atoms atom ON atom.atom_id = due.atom_id
      WHERE atom.status = 'active' AND due.due_at <= ?
    `).get(now) as { count: number };
    return Number(row.count);
  }

  upsertEntity(entity: MemoryEntity): void {
    upsertMemoryEntity(this.db, entity);
  }

  getEntity(entityId: string): MemoryEntity | undefined {
    return getMemoryEntity(this.db, entityId);
  }

  upsertRelation(relation: MemoryRelation): void {
    upsertMemoryRelation(this.db, relation);
  }

  hasRelation(relationId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS found FROM relations WHERE relation_id = ?').get(relationId));
  }

  entityReferenceBlockers(entityId: string): MemoryEntityReferenceBlockers {
    return memoryEntityReferenceBlockers(this.db, entityId);
  }

  relationReferenceBlockers(relationId: string): MemoryRelationReferenceBlockers {
    return memoryRelationReferenceBlockers(this.db, relationId);
  }

  purgeRelation(relationId: string): boolean {
    const blockers = this.relationReferenceBlockers(relationId);
    if (blockers.atomIds.length > 0) {
      throw new Error(`Memory relation ${relationId} still has atom references: ${JSON.stringify(blockers)}`);
    }
    const row = this.db.prepare('SELECT status FROM relations WHERE relation_id = ?')
      .get(relationId) as { status: MemoryRelation['status'] } | undefined;
    if (!row) return false;
    if (row.status !== 'deleted') throw new Error(`Memory relation ${relationId} must be marked deleted before purge.`);
    return Number(this.db.prepare('DELETE FROM relations WHERE relation_id = ?').run(relationId).changes) > 0;
  }

  purgeEntity(entityId: string): boolean {
    const blockers = this.entityReferenceBlockers(entityId);
    if (blockers.atomIds.length > 0 || blockers.inboundRelationIds.length > 0 || blockers.outboundRelationIds.length > 0) {
      throw new Error(`Memory entity ${entityId} still has references: ${JSON.stringify(blockers)}`);
    }
    const row = this.db.prepare('SELECT status FROM entities WHERE entity_id = ?')
      .get(entityId) as { status: MemoryEntity['status'] } | undefined;
    if (!row) return false;
    if (row.status !== 'deleted') throw new Error(`Memory entity ${entityId} must be marked deleted before purge.`);
    return Number(this.db.prepare('DELETE FROM entities WHERE entity_id = ?').run(entityId).changes) > 0;
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
    const embeddingHash = memoryAtomEmbeddingHash(atom);
    const activation = memoryAtomActivation(atom, atom.updatedAt);
    const existing = this.db.prepare('SELECT embedding_hash, embedding_status FROM atoms WHERE atom_id = ?')
      .get(atom.id) as { embedding_hash: string; embedding_status: string } | undefined;
    const embeddingChanged = existing?.embedding_hash !== embeddingHash;
    const embeddingConfigured = this.embeddings.isConfigured();
    const embeddingEligible = embeddingConfigured && atom.status === 'active';
    const embeddingStatus = !embeddingEligible
      ? 'disabled'
      : embeddingChanged
        ? 'pending'
        : existing?.embedding_status === 'ready' || existing?.embedding_status === 'stale'
          ? existing.embedding_status
          : 'pending';
    if (embeddingChanged || !embeddingEligible) {
      this.db.prepare('DELETE FROM atom_vectors WHERE atom_id = ?').run(atom.id);
    }
    else this.db.prepare('UPDATE atom_vectors SET content_hash = ? WHERE atom_id = ?').run(atom.contentHash, atom.id);
    this.db.prepare(`
      INSERT INTO atoms (
        atom_id, file_path, revision, domain, branch, parent_id, scope, scope_key,
        tier, statement_kind, epistemic_status, status, resolution_status,
        title, summary, content_hash, embedding_hash, embedding_status,
        activation_score, activation_updated_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        embedding_hash = excluded.embedding_hash,
        embedding_status = excluded.embedding_status,
        embedding_engine_id = CASE WHEN excluded.embedding_status IN ('ready', 'stale') THEN atoms.embedding_engine_id ELSE NULL END,
        embedding_model_id = CASE WHEN excluded.embedding_status IN ('ready', 'stale') THEN atoms.embedding_model_id ELSE NULL END,
        embedding_dimensions = CASE WHEN excluded.embedding_status IN ('ready', 'stale') THEN atoms.embedding_dimensions ELSE NULL END,
        activation_score = excluded.activation_score,
        activation_updated_at = excluded.activation_updated_at,
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
      embeddingHash,
      embeddingStatus,
      activation.score,
      activation.computedAt,
      atom.createdAt,
      atom.updatedAt,
    );
    if (embeddingChanged) {
      this.db.prepare('DELETE FROM atom_fts WHERE atom_id = ?').run(atom.id);
      this.db.prepare(`
        INSERT INTO atom_fts (atom_id, title, summary, content, retrieval_keys)
        VALUES (?, ?, ?, ?, ?)
      `).run(atom.id, atom.title, atom.summary, atom.content, atom.retrievalKeys.join(' '));
    }
    replaceAtomGraphReferences(this.db, atom);
    replaceAtomDueRecords(this.db, atom);
  }

  private verifyAtom(atom: MemoryAtom): MemoryAtom {
    const verified = parseMemoryAtom(structuredClone(atom));
    if (memoryAtomContentHash(verified) !== verified.contentHash) {
      throw new Error(`Memory atom content hash mismatch: ${verified.id}`);
    }
    return verified;
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
