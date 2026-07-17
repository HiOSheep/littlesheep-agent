// @littlesheep/snapshot — public API
//
// Pre-write snapshotting for memory rollback (Phase B). SnapshotMemoryStore
// decorates a MemoryStoreLike, capturing the file's pre-write content before
// each write. SnapshotIndex tracks snapshots for CLI-driven rollback.
//
// Composable with SafeMemoryStore (Phase A) via the MemoryStoreLike structural
// interface. Wrap order: Snapshot(outer) → Safe → base(inner).

export {
  SnapshotIndex,
  windowsSafeId,
  DEFAULT_MAX_SNAPSHOTS,
  type SnapshotTier,
  type SnapshotEntry,
  type SnapshotIndexOptions,
} from './snapshot-index.js';
export {
  SnapshotMemoryStore,
  type SnapshotMemoryStoreOptions,
} from './snapshot-memory-store.js';
export {
  GitCheckpointCoordinator,
  RunGitCheckpoint,
  type BeginRunCheckpointOptions,
  type CompleteRunCheckpointOptions,
  type GitCheckpointCoordinatorOptions,
  type RollbackCheckpointOptions,
  type VersioningMutationHook,
} from './git-checkpoint.js';
export {
  ShadowGitRepository,
  type ShadowGitRepositoryOptions,
} from './git-client.js';
