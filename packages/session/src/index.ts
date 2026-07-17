// @littlesheep/session — public API

export { SessionManager, type SessionManagerOptions } from './manager.js';
export { SessionCompactionStore } from './compaction-store.js';
export { acquireLock, tryAcquireLock } from './lock.js';
export {
  maybeCompact,
  selectForCompaction,
  type CompactionOptions,
  type CompactionSummaryInput,
  type CompactionSummaryOutput,
} from './compaction.js';
