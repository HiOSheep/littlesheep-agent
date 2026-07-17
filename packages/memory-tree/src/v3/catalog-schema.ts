export const MEMORY_CATALOG_SCHEMA_VERSION = 9;

export const MEMORY_CATALOG_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS atoms (
  atom_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL,
  domain TEXT NOT NULL,
  branch TEXT NOT NULL,
  parent_id TEXT,
  scope TEXT NOT NULL,
  scope_key TEXT,
  tier INTEGER NOT NULL,
  statement_kind TEXT NOT NULL,
  epistemic_status TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution_status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_hash TEXT NOT NULL,
  embedding_status TEXT NOT NULL,
  embedding_engine_id TEXT,
  embedding_model_id TEXT,
  embedding_dimensions INTEGER,
  activation_score REAL NOT NULL DEFAULT 0.25,
  activation_updated_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_atoms_parent ON atoms(parent_id);
CREATE INDEX IF NOT EXISTS idx_atoms_boundary ON atoms(branch, scope, scope_key, status);
CREATE INDEX IF NOT EXISTS idx_atoms_updated ON atoms(updated_at);
CREATE INDEX IF NOT EXISTS idx_atoms_embedding_work ON atoms(status, embedding_status, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS atom_fts USING fts5(
  atom_id UNINDEXED,
  title,
  summary,
  content,
  retrieval_keys,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS atom_vectors (
  atom_id TEXT PRIMARY KEY REFERENCES atoms(atom_id) ON DELETE CASCADE,
  vector_namespace TEXT NOT NULL DEFAULT 'memory-atom',
  engine_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS atom_access (
  id TEXT PRIMARY KEY,
  atom_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  retrieval_path TEXT NOT NULL,
  match_reason TEXT NOT NULL,
  entered_context INTEGER NOT NULL,
  disclosure_level TEXT NOT NULL,
  tokens_used INTEGER NOT NULL,
  accessed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_atom_time ON atom_access(atom_id, accessed_at DESC);

CREATE TABLE IF NOT EXISTS atom_feedback (
  id TEXT PRIMARY KEY,
  atom_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  verified INTEGER NOT NULL,
  evidence_refs TEXT NOT NULL,
  verify_stage_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_atom_time ON atom_feedback(atom_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL,
  atom_id TEXT,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_due (
  atom_id TEXT NOT NULL REFERENCES atoms(atom_id) ON DELETE CASCADE,
  due_kind TEXT NOT NULL,
  due_at TEXT NOT NULL,
  PRIMARY KEY(atom_id, due_kind)
);
CREATE INDEX IF NOT EXISTS idx_memory_due_time ON memory_due(due_at);

CREATE TABLE IF NOT EXISTS evidence_links (
  id TEXT PRIMARY KEY,
  atom_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_atom ON evidence_links(atom_id);

CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  owner_json TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT,
  external_key TEXT,
  label TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_external_boundary
  ON entities(entity_type, scope, scope_key, external_key)
  WHERE external_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS atom_entity_refs (
  atom_id TEXT NOT NULL REFERENCES atoms(atom_id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  PRIMARY KEY(atom_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_atom_entity_refs_entity ON atom_entity_refs(entity_id);

CREATE TABLE IF NOT EXISTS relations (
  relation_id TEXT PRIMARY KEY,
  from_entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  to_entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  relation_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT,
  source_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  authority_scope_json TEXT NOT NULL,
  relevance REAL NOT NULL,
  effective_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL,
  resolution_status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id, relation_type);

CREATE TABLE IF NOT EXISTS atom_relation_refs (
  atom_id TEXT NOT NULL REFERENCES atoms(atom_id) ON DELETE CASCADE,
  relation_id TEXT NOT NULL REFERENCES relations(relation_id),
  PRIMARY KEY(atom_id, relation_id)
);
CREATE INDEX IF NOT EXISTS idx_atom_relation_refs_relation ON atom_relation_refs(relation_id);

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  operation_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  atom_ids_json TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  expected_revisions_json TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  atom_id TEXT,
  operation_id TEXT,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(created_at DESC);
`;
