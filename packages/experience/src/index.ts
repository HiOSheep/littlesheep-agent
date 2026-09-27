// @littlesheep/experience — public API
//
// Structured experience database. ExperienceStore holds durable lessons/facts
// with confidence decay + maxEntries pruning (the project's controlled
// "forgetting"). Content is validated against injection patterns on append
// (reuses @littlesheep/safety).
//
// The legacy `record_experience` AgentTool factory was removed on 2026-09-27
// (SL-03): nothing assembled it — the retired EVOLVE path was its only caller —
// so it was definition plus public export. The store itself is still live: the
// CLI `import-repo` command appends to it, and the Runner registers it as the
// compatibility read branch for data roots that predate Memory v3.

export {
  ExperienceStore,
  type ExperienceEntry,
  type ExperienceInput,
  type ExperienceStoreOptions,
  type SearchQuery,
  DEFAULT_DECAY_FACTOR,
  DEFAULT_DELETE_BELOW,
  DEFAULT_MAX_ENTRIES,
} from './experience-store.js';
