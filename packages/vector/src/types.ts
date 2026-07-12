// @littlesheep/vector — types.ts
// Types for the vector store: tiered memory embeddings + semantic search.

import type { LlmClient } from '@littlesheep/llm';

/** Memory vector tier — controls retention + search scope. */
export type VectorTier =
  | 'daily'             // raw daily memory entry (≤30 days old)
  | 'monthly-summary'   // LLM-distilled monthly summary (≤12 months old)
  | 'yearly-summary';   // LLM-distilled yearly summary (>12 months old)

/** A stored vector record (metadata + embedding stored separately). */
export interface VectorRecord {
  /** Unique id (generated on insert). */
  id: string;
  /** The source text that was embedded. */
  text: string;
  /** Tier controls retention + search filtering. */
  tier: VectorTier;
  /** YYYY-MM-DD (daily) | YYYY-MM (monthly) | YYYY (yearly). */
  date: string;
  /** Source file path (for removal on archive). */
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
