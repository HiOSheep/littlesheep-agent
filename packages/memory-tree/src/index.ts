// @littlesheep/memory-tree — public API

export {
  InjectionTier,
  type MemoryFragment,
  type MemoryIndexEntry,
  type BranchIndex,
  type BranchExpansion,
  type BranchExpandRequest,
  type BranchSearchRequest,
  type MemoryBranchContext,
  type MemoryBranch,
  type BranchDescription,
  type MemoryTreeOptions,
  type MemoryRunRegistration,
  type MemoryAccessRecord,
  type MemoryAccessLedger,
  type MemoryExpandOptions,
  type MemorySearchOptions,
  type MemoryQueryResult,
  type MemoryBranchKind,
  type MemoryScope,
  type MemoryWriteIntent,
  type MemoryNode,
  type MemoryNodeStatus,
  type MemoryManagementAction,
  type MemoryManagementAuditRecord,
  type MemoryManagementResult,
  type MemoryMigrationRecord,
  type MemoryTreeDocument,
  type MemoryWritePolicy,
  type MemoryWriteResult,
  type LogFn,
  type ProjectEntry,
  type ProjectIndex,
  type GitLogEntry,
} from './types.js';
export { MemoryTree } from './memory-tree.js';
export { ProjectMemoryBranch, type ProjectMemoryBranchDeps } from './project-memory-branch.js';
export { TreeMemoryBranch, DEFAULT_BRANCH_SPECS, type TreeMemoryBranchOptions } from './tree-memory-branch.js';
export { CompositeMemoryBranch, type CompositeMemoryBranchOptions } from './composite-memory-branch.js';
export {
  LegacyLongTermBranch,
  LegacyDailyBranch,
  LegacyExperienceBranch,
  SemanticDailyBranch,
  LEGACY_MEMORY_MIGRATION_ID,
  migrateLegacyMemorySources,
  type ExperienceStoreLike,
  type VectorMemorySearchLike,
  type LegacyMemoryMigrationOptions,
  type LegacyMemoryMigrationResult,
} from './legacy-memory-branches.js';
export {
  MemoryRepository,
  MemoryWriteService,
  type MemoryRepositoryOptions,
  type MemoryWriteServiceOptions,
  type MemoryWriteServiceLike,
} from './memory-repository.js';
export {
  createMemoryTreeTool,
  createMemorySearchCompatibilityTool,
  type MemoryToolOptions,
} from './memory-tool.js';
export { fetchGitLog, fetchLatestCommitDate, parseGitLog } from './git-log.js';
export { readProjectIndex } from './project-index.js';
export { estimateTokens, activityScore, truncateChunk, MIN_USEFUL_TOKENS } from './util.js';
