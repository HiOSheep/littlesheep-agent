// @littlesheep/vector — public API
// SQLite-backed vector store for tiered memory embeddings + semantic search.

export { VectorStore } from './vector-store.js';
export type {
  VectorTier,
  VectorRecord,
  VectorSearchResult,
  VectorInsert,
  VectorStoreOptions,
  VectorSearchFilter,
} from './types.js';
