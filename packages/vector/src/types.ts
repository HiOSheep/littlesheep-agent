// @littlesheep/vector — types.ts
// Types for the vector store: tiered memory embeddings + semantic search.

import type { LlmClient } from '@littlesheep/llm';

/**
 * Legacy v2 vector tier retained for reading existing local databases.
 *
 * The Memory v3 runtime does not write this store or use these tiers as an
 * authority. New Atom embeddings belong to the Memory v3 local catalog.
 */
export type VectorTier =
  | 'daily'
  | 'monthly-summary'
  | 'yearly-summary';

/** A stored vector record (metadata + embedding stored separately). */
export interface VectorRecord {
  /** Unique id (generated on insert). */
  id: string;
  /** The source text that was embedded. */
  text: string;
  /** Legacy tier used only for compatibility filtering. */
  tier: VectorTier;
  /** YYYY-MM-DD (daily) | YYYY-MM (monthly) | YYYY (yearly). */
  date: string;
  /** Historical source file path. */
  source: string;
  /** Creation timestamp (Date.now()). */
  createdAt: number;
}

/** A search result with similarity score. */
export interface VectorSearchResult extends VectorRecord {
  /** Cosine similarity score (0-1, higher = more similar). */
  score: number;
}

/** Input for insert (id + createdAt auto-generated). */
export type VectorInsert = Omit<VectorRecord, 'id' | 'createdAt'>;

/** Options for constructing a VectorStore. */
export interface VectorStoreOptions {
  /** Path to the SQLite database file (created if missing). */
  dbPath: string;
  /** Embedding model name (e.g. 'text-embedding-3-small'). */
  embeddingModel: string;
  /** Embedding vector dimensions (e.g. 1536 for text-embedding-3-small). */
  dimensions: number;
  /** LLM client used to generate embeddings. */
  llm: LlmClient;
}

/** Filter for vector search (all fields optional, combined with AND). */
export interface VectorSearchFilter {
  /** Restrict to specific tiers. */
  tiers?: VectorTier[];
  /** Date lower bound (inclusive). Compares lexicographically on the `date` string. */
  since?: string;
  /** Date upper bound (inclusive). */
  until?: string;
}
