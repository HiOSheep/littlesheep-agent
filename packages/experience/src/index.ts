// @littlesheep/experience — public API
//
// Structured experience database for self-evolution. ExperienceStore holds
// durable lessons/facts with confidence decay + maxEntries pruning (the
// project's controlled "forgetting"). Content is validated against injection
// patterns on append (reuses @littlesheep/safety).

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

export { createRecordExperienceTool, type RecordExperienceToolDeps } from './record-experience.js';
