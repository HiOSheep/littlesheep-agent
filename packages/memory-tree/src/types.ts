// @littlesheep/memory-tree - index-first memory runtime contracts.

import type { SessionId } from '@littlesheep/types';

export enum InjectionTier {
  T0_CORE = 0,
  T1_ESSENTIAL = 1,
  T2_RELEVANT = 2,
  T3_DETAIL = 3,
}

export type MemoryScope = 'global' | 'workspace' | 'project' | 'session';
export type MemoryResourceScope = MemoryScope | 'run';
export type MemoryBranchKind = 'long-term' | 'daily' | 'project' | 'experience';
export type MemoryBranchCategory = MemoryBranchKind | 'resources';
export type MemoryAccessAction = 'root_index' | 'branch_index' | 'expand' | 'deep_search';

export type MemoryResourceKind =
  | 'agent-instructions'
  | 'persona'
  | 'user-profile'
  | 'tool-guidance'
  | 'legacy-memory'
  | 'skill'
  | 'project-guideline'
  | 'ui-guideline'
  | 'taskbook'
  | 'knowledge'
  | 'summary-memory'
  | 'attachment-manifest'
  | 'attachment'
  | 'runtime-event-ledger'
  | 'workspace-index'
  | 'project-memory-projection';

export type MemoryResourceAuthority = 'authoritative' | 'derived' | 'compatibility' | 'external';
export type MemoryResourcePrivacy = 'private' | 'project-private' | 'shareable' | 'public';
export type MemoryResourceStatus = 'active' | 'missing' | 'disabled' | 'conflict';
export type MemoryResourceSourceKind = 'file' | 'memory-node' | 'session-summary' | 'attachment' | 'runtime-event' | 'workspace-index';
export type MemoryResourceManagementAction = 'disable' | 'restore' | 'mark-missing' | 'mark-conflict' | 'remove' | 'rebind';
export type MemoryResourceManagementActor = 'user' | 'system';
export type MemoryResourceOwnerKind = 'builtin' | 'user' | 'external' | 'plugin';
export type MemoryResourceLifecycleController = 'skill-loader' | 'plugin-host';

export interface MemoryResourceOwner {
  kind: MemoryResourceOwnerKind;
  id: string;
  controller: MemoryResourceLifecycleController;
}

export interface MemoryResourceSource {
  kind: MemoryResourceSourceKind;
  path?: string;
  id?: string;
  contentHash?: string;
}

/** Metadata-only registration. Registering a resource never copies or injects its body. */
export interface MemoryResourceRegistration {
  version: 1;
  id: string;
  kind: MemoryResourceKind;
  title: string;
  description: string;
  tier: InjectionTier;
  branch?: MemoryBranchKind;
  scope: MemoryResourceScope;
  scopeKey?: string;
  authority: MemoryResourceAuthority;
  privacy: MemoryResourcePrivacy;
  source: MemoryResourceSource;
  indexKeys: string[];
  status: MemoryResourceStatus;
  registryGroup: string;
  /** The subsystem that owns lifecycle changes for this indexed projection. */
  owner?: MemoryResourceOwner;
  registeredAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryResourceQuery {
  kind?: MemoryResourceKind;
  tier?: InjectionTier;
  branch?: MemoryBranchKind;
  scope?: MemoryResourceScope;
  scopeKey?: string;
  status?: MemoryResourceStatus;
  registryGroup?: string;
}

export interface MemoryResourceManagementAuditRecord {
  id: string;
  resourceId: string;
  resourceKind: MemoryResourceKind;
  registryGroup: string;
  action: MemoryResourceManagementAction;
  actor: MemoryResourceManagementActor;
  at: string;
  reason: string;
  fromStatus: MemoryResourceStatus;
  toStatus?: MemoryResourceStatus;
  fromSourcePath?: string;
  toSourcePath?: string;
}

export interface MemoryResourceManagementResult {
  resource?: MemoryResourceRegistration;
  audit?: MemoryResourceManagementAuditRecord;
  changed: boolean;
  removed: boolean;
}

export interface MemoryResourceRebindPatch {
  sourcePath: string;
  scopeKey?: string;
  title?: string;
  kind?: MemoryResourceKind;
  indexKeys?: string[];
  contentHash?: string;
  status?: Exclude<MemoryResourceStatus, 'disabled'>;
}

export interface MemorySource {
  source: string;
  kind: string;
  generatedAt: string;
  runId?: string;
  [key: string]: unknown;
}

/** One traceable unit returned by a selected memory branch. */
export interface MemoryFragment {
  id: string;
  branchId: string;
  parentNodeId?: string;
  tier: InjectionTier;
  priority: number;
  content: string;
  tokenEstimate: number;
  truncatable: boolean;
  /** Stable within the source; prevents repeated intervention in one run. */
  dedupKey: string;
  /** Why this fragment matched the current branch/query. */
  matchReason: string;
  metadata: MemorySource;
}

export interface MemoryIndexEntry {
  id: string;
  title: string;
  summary: string;
  hasChildren: boolean;
  searchKeys?: string[];
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface BranchIndex {
  branchId: string;
  displayName: string;
  summary: string;
  entries: MemoryIndexEntry[];
  generatedAt: string;
  source: string;
  truncated?: boolean;
  nextCursor?: string;
}

export interface BranchExpansion {
  branchId: string;
  nodeId?: string;
  query?: string;
  fragments: MemoryFragment[];
  /** Returned instead of blindly truncating an oversized subtree. */
  childIndex?: MemoryIndexEntry[];
  truncated: boolean;
  nextCursor?: string;
}

export interface BranchExpandRequest {
  nodeId?: string;
  query?: string;
  limit: number;
  tokenBudget: number;
  cursor?: string;
}

export interface BranchSearchRequest {
  query: string;
  limit: number;
  tokenBudget: number;
  cursor?: string;
}

export interface MemoryBranchContext {
  runId: string;
  query: string;
  sessionId: SessionId;
  recentHistory: ReadonlyArray<{ role: string; content: string }>;
  workspace: string;
  signal: AbortSignal;
  now: Date;
}

export interface BranchDescription {
  id: string;
  displayName: string;
  kind: MemoryBranchCategory;
  purpose: string;
  whenToUse: string;
  searchHints: string[];
  metadata?: Record<string, unknown>;
}

/** A branch is inert until the agent explicitly requests its index/content. */
export interface MemoryBranch {
  readonly id: string;
  readonly displayName: string;
  readonly kind: MemoryBranchCategory;
  readonly purpose: string;
  readonly whenToUse: string;
  readonly searchHints: readonly string[];
  getIndex(ctx: MemoryBranchContext): Promise<BranchIndex>;
  expand(ctx: MemoryBranchContext, request: BranchExpandRequest): Promise<BranchExpansion>;
  search(ctx: MemoryBranchContext, request: BranchSearchRequest): Promise<MemoryFragment[]>;
  invalidate?(): void | Promise<void>;
  describe?(): BranchDescription;
}

export interface MemoryRunRegistration {
  runId: string;
  sessionId: SessionId;
  query: string;
  recentHistory: ReadonlyArray<{ role: string; content: string }>;
  workspace: string;
  signal?: AbortSignal;
  now?: Date;
  /** Exact bounded T0 index inserted for this run. */
  rootIndex?: string;
  /** Number of branch/resource directory entries represented by rootIndex. */
  rootSourceCount?: number;
}

export interface MemoryAccessRecord {
  id: string;
  action: MemoryAccessAction;
  at: string;
  branchId?: string;
  nodeId?: string;
  query?: string;
  status: 'ok' | 'degraded' | 'error';
  fragmentIds: string[];
  sourceCount: number;
  dedupedCount: number;
  tokensUsed: number;
  tokenBudget: number;
  reason?: string;
  error?: string;
}

export interface MemoryAccessLedger {
  runId: string;
  sessionId: SessionId;
  workspace: string;
  startedAt: string;
  endedAt?: string;
  totalTokenBudget: number;
  tokensUsed: number;
  expandedBranches: string[];
  dedupKeys: string[];
  records: MemoryAccessRecord[];
}

export interface MemoryTreeOptions {
  /** Maximum memory content allowed to enter one run through all expansions. */
  totalRunTokenBudget: number;
  /** Maximum content returned by one branch in one run. */
  perBranchTokenBudget: number;
  /** Stable root-index character ceiling. */
  rootIndexMaxChars: number;
  /** Number of finished ledgers retained in memory for diagnostics. */
  maxRetainedLedgers: number;
  /** Read-side safety envelope/sanitizer. */
  sanitize?: (content: string) => string;
  log?: LogFn;
}

export interface MemoryExpandOptions {
  branchId: string;
  nodeId?: string;
  query?: string;
  limit?: number;
  tokenBudget?: number;
  cursor?: string;
}

export interface MemorySearchOptions {
  query: string;
  /** Deep search is always scoped to one branch selected through its index. */
  branchId: string;
  limit?: number;
  tokenBudget?: number;
  cursor?: string;
}

export interface MemoryQueryResult {
  action: 'expand' | 'deep_search';
  branchId?: string;
  fragments: MemoryFragment[];
  childIndex?: MemoryIndexEntry[];
  truncated: boolean;
  nextCursor?: string;
  errors: Array<{ branchId: string; message: string }>;
  dedupedCount: number;
  tokensUsed: number;
  tokenBudget: number;
}

export type MemoryNodeStatus = 'active' | 'archived' | 'deleted';
export type MemoryWriteStage = 'evolve' | 'capture' | 'tool' | 'migration';
export type MemoryManagementAction = 'archive' | 'restore' | 'delete' | 'promote' | 'demote';

/** Structured write contract shared by EVOLVE, CAPTURE and future management UI. */
export interface MemoryWriteIntent {
  id?: string;
  branch: MemoryBranchKind;
  parentNodeId: string;
  scope: MemoryScope;
  /** Workspace/project/session identifier when scope is not global. */
  scopeKey?: string;
  tier: InjectionTier;
  summary: string;
  content: string;
  retrievalKeys: string[];
  sourceRunId: string;
  sourceStage: MemoryWriteStage;
  /** Concrete files, records or external sources that produced this memory. */
  sourceRefs?: string[];
  importance: number;
  confidence: number;
  reason: string;
  createdAt?: string;
}

export interface MemoryNode {
  id: string;
  branch: MemoryBranchKind;
  parentNodeId?: string;
  childIds: string[];
  scope: MemoryScope;
  scopeKey?: string;
  tier: InjectionTier;
  summary: string;
  content: string;
  retrievalKeys: string[];
  importance: number;
  confidence: number;
  reason: string;
  sourceRunIds: string[];
  sourceStages: MemoryWriteStage[];
  sourceRefs?: string[];
  status: MemoryNodeStatus;
  createdAt: string;
  updatedAt: string;
  isBranchRoot?: boolean;
  mergedFrom?: string[];
}

export interface MemoryWriteAuditRecord {
  id: string;
  intentId: string;
  sourceRunId: string;
  branch: MemoryBranchKind;
  at: string;
  decision: 'created' | 'merged' | 'reinforced' | 'rejected' | 'queued';
  nodeId?: string;
  reason: string;
}

export interface MemoryManagementAuditRecord {
  id: string;
  nodeId: string;
  branch: MemoryBranchKind;
  action: MemoryManagementAction;
  at: string;
  reason: string;
  fromStatus: MemoryNodeStatus;
  toStatus: MemoryNodeStatus;
  fromTier: InjectionTier;
  toTier: InjectionTier;
}

export interface MemoryManagementResult {
  node: MemoryNode;
  audit: MemoryManagementAuditRecord;
}

export interface MemoryMigrationRecord {
  id: string;
  completedAt: string;
  sourceCount: number;
  created: number;
  merged: number;
  reinforced: number;
  rejected: number;
}

export interface MemorySchemaMigrationRecord {
  id: string;
  fromVersion: number;
  toVersion: number;
  startedAt: string;
  completedAt: string;
  backupFile: string;
}

export interface QueuedMemoryWrite {
  id: string;
  intent: MemoryWriteIntent;
  error: string;
  queuedAt: string;
  attempts: number;
}

export interface MemoryTreeDocumentV1 {
  version: 1;
  updatedAt: string;
  nodes: Record<string, MemoryNode>;
  recoveryQueue: QueuedMemoryWrite[];
  writeAudit: MemoryWriteAuditRecord[];
  managementAudit: MemoryManagementAuditRecord[];
  migrations: Record<string, MemoryMigrationRecord>;
}

export interface MemoryTreeDocument {
  version: 2;
  registryVersion: 1;
  updatedAt: string;
  nodes: Record<string, MemoryNode>;
  resources: Record<string, MemoryResourceRegistration>;
  recoveryQueue: QueuedMemoryWrite[];
  writeAudit: MemoryWriteAuditRecord[];
  managementAudit: MemoryManagementAuditRecord[];
  resourceManagementAudit: MemoryResourceManagementAuditRecord[];
  migrations: Record<string, MemoryMigrationRecord>;
  schemaMigrations: MemorySchemaMigrationRecord[];
}

export interface MemoryWritePolicy {
  experienceThreshold: number;
  longTermConfidenceThreshold: number;
  longTermImportanceThreshold: number;
  projectConfidenceThreshold: number;
  duplicateSimilarityThreshold: number;
  maxAuditRecords: number;
}

export interface MemoryWriteResult {
  intentId: string;
  decision: MemoryWriteAuditRecord['decision'];
  reason: string;
  node?: MemoryNode;
  queuedId?: string;
}

export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;

/** A single project entry in ~/.littlesheep/projects/index.json. */
export interface ProjectEntry {
  id: string;
  path: string;
  lastActiveAt: string;
}

export interface ProjectIndex {
  projects: ProjectEntry[];
}

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
}
