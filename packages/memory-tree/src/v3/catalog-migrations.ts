// Owns additive SQLite catalog upgrades and bounded legacy data backfills.

import type { DatabaseSync } from 'node:sqlite';
import { memoryEmbeddingHashFromFields } from './catalog-helpers.js';

export function upgradeMemoryCatalogSchema(db: DatabaseSync): void {
  const relationColumns = columns(db, 'relations');
  if (!relationColumns.has('source_refs_json')) {
    db.exec("ALTER TABLE relations ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]';");
  }
  const atomColumns = columns(db, 'atoms');
  if (!atomColumns.has('embedding_hash')) {
    db.exec("ALTER TABLE atoms ADD COLUMN embedding_hash TEXT NOT NULL DEFAULT '';");
  }
  if (!atomColumns.has('activation_score')) {
    db.exec('ALTER TABLE atoms ADD COLUMN activation_score REAL NOT NULL DEFAULT 0.25;');
  }
  if (!atomColumns.has('activation_updated_at')) {
    db.exec("ALTER TABLE atoms ADD COLUMN activation_updated_at TEXT NOT NULL DEFAULT '';");
  }
  const vectorColumns = columns(db, 'atom_vectors');
  if (!vectorColumns.has('vector_namespace')) {
    db.exec("ALTER TABLE atom_vectors ADD COLUMN vector_namespace TEXT NOT NULL DEFAULT 'memory-atom';");
  }
  if (!vectorColumns.has('embedding_hash')) {
    db.exec("ALTER TABLE atom_vectors ADD COLUMN embedding_hash TEXT NOT NULL DEFAULT '';");
  }
  backfillEmbeddingHashes(db);
  backfillActivationProjection(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vectors_namespace_engine
      ON atom_vectors(vector_namespace, engine_id, model_id, engine_version);
    CREATE INDEX IF NOT EXISTS idx_atoms_activation
      ON atoms(status, activation_score DESC, activation_updated_at DESC);
  `);
}

function backfillActivationProjection(db: DatabaseSync): void {
  db.exec(`
    UPDATE atoms
    SET activation_score = COALESCE((
      SELECT MAX(0.05, MIN(1.0,
        (
          SUM(CASE WHEN feedback.outcome = 'useful' THEN CASE WHEN feedback.verified = 1 THEN 2.0 ELSE 1.0 END ELSE 0 END)
          + 1.0
        ) / (
          SUM(CASE WHEN feedback.outcome = 'useful' THEN CASE WHEN feedback.verified = 1 THEN 2.0 ELSE 1.0 END ELSE 0 END)
          + SUM(CASE
              WHEN feedback.outcome = 'not-useful' THEN CASE WHEN feedback.verified = 1 THEN 2.0 ELSE 1.0 END
              WHEN feedback.outcome = 'conflict' THEN CASE WHEN feedback.verified = 1 THEN 3.0 ELSE 1.5 END
              WHEN feedback.outcome = 'stale' THEN CASE WHEN feedback.verified = 1 THEN 2.5 ELSE 1.25 END
              ELSE 0
            END)
          + 2.0
        )
      ))
      FROM atom_feedback feedback
      WHERE feedback.atom_id = atoms.atom_id
    ), 0.25),
    activation_updated_at = COALESCE((
      SELECT MAX(feedback.created_at)
      FROM atom_feedback feedback
      WHERE feedback.atom_id = atoms.atom_id
    ), updated_at)
    WHERE activation_updated_at = '';
  `);
}

function backfillEmbeddingHashes(db: DatabaseSync): void {
  const selectLegacyAtoms = db.prepare(`
    SELECT atom.atom_id, atom.title, atom.summary, fts.content, fts.retrieval_keys
    FROM atoms atom
    JOIN atom_fts fts ON fts.atom_id = atom.atom_id
    WHERE atom.embedding_hash = ''
    ORDER BY atom.atom_id ASC
    LIMIT 250
  `);
  const updateEmbeddingHash = db.prepare('UPDATE atoms SET embedding_hash = ? WHERE atom_id = ?');
  while (true) {
    const rows = selectLegacyAtoms.all() as unknown as Array<{
      atom_id: string;
      title: string;
      summary: string;
      content: string;
      retrieval_keys: string;
    }>;
    if (rows.length === 0) break;
    for (const row of rows) {
      updateEmbeddingHash.run(memoryEmbeddingHashFromFields({
        title: row.title,
        summary: row.summary,
        content: row.content,
        retrievalKeys: row.retrieval_keys,
      }), row.atom_id);
    }
  }
  db.exec(`
    UPDATE atom_vectors
    SET embedding_hash = (
      SELECT atom.embedding_hash FROM atoms atom WHERE atom.atom_id = atom_vectors.atom_id
    )
    WHERE embedding_hash = ''
      AND content_hash = (
        SELECT atom.content_hash FROM atoms atom WHERE atom.atom_id = atom_vectors.atom_id
      )
      AND COALESCE((
        SELECT atom.embedding_hash FROM atoms atom WHERE atom.atom_id = atom_vectors.atom_id
      ), '') != '';
  `);
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}
