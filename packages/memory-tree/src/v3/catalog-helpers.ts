import { type DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  MemoryAtom,
  MemoryCatalogEntry,
  MemoryCatalogSearchOptions,
} from './contracts.js';

export interface AtomRow {
  atom_id: string;
  file_path: string;
  revision: number | bigint;
  domain: MemoryCatalogEntry['domain'];
  branch: MemoryCatalogEntry['branch'];
  parent_id: string | null;
  scope: MemoryCatalogEntry['scope'];
  scope_key: string | null;
  tier: number | bigint;
  statement_kind: MemoryCatalogEntry['statementKind'];
  epistemic_status: MemoryCatalogEntry['epistemicStatus'];
  status: MemoryCatalogEntry['status'];
  resolution_status: MemoryCatalogEntry['resolutionStatus'];
  content_hash: string;
  embedding_status: MemoryCatalogEntry['embeddingStatus'];
  embedding_engine_id: string | null;
  embedding_model_id: string | null;
  embedding_dimensions: number | bigint | null;
  created_at: string;
  updated_at: string;
}

export interface VectorRow extends AtomRow {
  embedding: Uint8Array;
}

export function scopedAtomQuery(
  options: MemoryCatalogSearchOptions,
  selectSql: string,
  additionalWhere: string,
  orderBy: string,
  limit: number,
): { sql: string; prefixParams: SQLInputValue[] } {
  const root = options.subtreeRootId ?? null;
  return {
    sql: `
      WITH RECURSIVE subtree(atom_id) AS (
        SELECT CAST(? AS TEXT)
        UNION ALL
        SELECT child.atom_id FROM atoms child JOIN subtree parent ON child.parent_id = parent.atom_id
      )
      ${selectSql}
      WHERE a.branch = ? AND a.scope = ? AND a.scope_key IS ?
        ${options.includeArchived ? '' : "AND a.status = 'active'"}
        AND (? IS NULL OR a.atom_id IN (SELECT atom_id FROM subtree))
        AND ${additionalWhere}
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `,
    prefixParams: [root, options.branch, options.scope, options.scopeKey ?? null, root],
  };
}

export function rowToEntry(row: AtomRow): MemoryCatalogEntry {
  return {
    atomId: row.atom_id,
    filePath: row.file_path,
    revision: Number(row.revision),
    domain: row.domain,
    branch: row.branch,
    parentId: row.parent_id ?? undefined,
    scope: row.scope,
    scopeKey: row.scope_key ?? undefined,
    tier: Number(row.tier) as MemoryCatalogEntry['tier'],
    statementKind: row.statement_kind,
    epistemicStatus: row.epistemic_status,
    status: row.status,
    resolutionStatus: row.resolution_status,
    contentHash: row.content_hash,
    embeddingStatus: row.embedding_status,
    embeddingEngineId: row.embedding_engine_id ?? undefined,
    embeddingModelId: row.embedding_model_id ?? undefined,
    embeddingDimensions: row.embedding_dimensions === null ? undefined : Number(row.embedding_dimensions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toFtsQuery(query: string): string {
  const tokens = query
    .normalize('NFKC')
    .split(/\s+/u)
    .map((token) => token.replace(/["*:^(){}[\]]/gu, '').trim())
    .filter(Boolean)
    .slice(0, 16);
  return tokens.map((token) => `"${token.replace(/"/gu, '""')}"`).join(' OR ');
}

export function embeddingText(atom: MemoryAtom): string {
  const header = [atom.title, atom.summary, atom.retrievalKeys.join(' ')].filter(Boolean).join('\n');
  const remaining = Math.max(0, 32_000 - header.length - 1);
  return `${header}\n${atom.content.slice(0, remaining)}`;
}

export function vectorToBuffer(vector: number[]): Buffer {
  const values = Float32Array.from(vector);
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

export function bufferToVector(bytes: Uint8Array): Float32Array {
  const copy = Uint8Array.from(bytes);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

export function assertScope(value: { scope: string; scopeKey?: string }): void {
  if (value.scope === 'global' && value.scopeKey !== undefined) {
    throw new Error('Global memory catalog queries cannot include scopeKey.');
  }
  if (value.scope !== 'global' && !value.scopeKey) {
    throw new Error(`${value.scope} memory catalog queries require scopeKey.`);
  }
}

export function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value!)));
}

export function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

export function pruneTable(
  db: DatabaseSync,
  table: string,
  idColumn: string,
  timeColumn: string,
  maximum: number,
): void {
  db.prepare(`
    DELETE FROM ${table} WHERE ${idColumn} IN (
      SELECT ${idColumn} FROM ${table}
      ORDER BY ${timeColumn} DESC, ${idColumn} DESC
      LIMIT -1 OFFSET ?
    )
  `).run(maximum);
}

export function scalarCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number | bigint };
  return Number(row.count);
}
