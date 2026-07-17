// Owns scoped FTS query construction and result projection for the Memory v3 catalog.

import type { DatabaseSync } from 'node:sqlite';
import type { MemoryCatalogSearchOptions, MemoryCatalogSearchResult } from './contracts.js';
import {
  boundedLimit,
  rowToEntry,
  scopedAtomQuery,
  toFtsQuery,
  type AtomRow,
} from './catalog-helpers.js';

export function searchMemoryCatalogFts(
  db: DatabaseSync,
  query: string,
  options: MemoryCatalogSearchOptions,
): MemoryCatalogSearchResult[] {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];
  const limit = boundedLimit(options.limit, 20, 200);
  const { sql, prefixParams } = scopedAtomQuery(options, `
    SELECT a.*, bm25(atom_fts) AS fts_rank
    FROM atom_fts
    JOIN atoms a ON a.atom_id = atom_fts.atom_id
  `, `atom_fts MATCH ?`, 'fts_rank ASC, a.updated_at DESC', limit);
  const rows = db.prepare(sql).all(...prefixParams, ftsQuery) as unknown as Array<AtomRow & { fts_rank: number }>;
  return rows.map((row) => ({
    entry: rowToEntry(row),
    score: 1 / (1 + Math.abs(Number(row.fts_rank))),
    matchReason: 'fts',
  }));
}
