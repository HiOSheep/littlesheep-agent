// Owns the versioned Memory v3 storage, epistemic, evidence, graph, and embedding contracts.

import type { InjectionTier, MemoryBranchKind, MemoryScope, MemoryWriteStage } from '../types.js';
import type {
  AuthorityScope,
  EpistemicStatus,
  MemoryActorRef,
  MemoryDomain,
  StatementKind,
} from '../epistemic.js';
export type {
  AuthorityKind,
  AuthorityScope,
  EpistemicStatus,
  MemoryActorKind,
  MemoryActorRef,
  MemoryAuthorityScope,
  MemoryDomain,
  MemoryWriteEpistemicMetadata,
  StatementKind,
} from '../epistemic.js';

export const MEMORY_ATOM_VERSION = 3 as const;
export const MEMORY_EVENT_VERSION = 1 as const;
export const MEMORY_OPERATION_VERSION = 1 as const;
export const MEMORY_IMMUTABLE_FACT_VERSION = 1 as const;

export type MemoryDisclosureLevel = 'D0' | 'D1' | 'D2' | 'D3';

export type MemoryAtomStatus = 'active' | 'archived' | 'tombstone';

export type MemoryResolutionStatus =
  | 'unresolved'
  | 'proposed'
  | 'under-review'
  | 'adopted'
  | 'rejected'
  | 'resolved'
  | 'superseded';

export type MemoryUseOutcome = 'useful' | 'not-useful' | 'conflict' | 'stale';

export interface MemoryVerifiedUsefulness {
  useful: number;
  notUseful: number;
  conflicts: number;
  stale: number;
  lastOutcome?: MemoryUseOutcome;
}

export interface MemoryAtomInvalidation {
  at: string;
  reason: string;
  priorEpistemicStatus: EpistemicStatus;
  priorResolutionStatus: MemoryResolutionStatus;
}

export interface MemoryAtomMerge {
  intoAtomId: string;
  at: string;
  reason: string;
}

export interface MemoryAtom {
  version: typeof MEMORY_ATOM_VERSION;
  id: string;
  revision: number;
  domain: MemoryDomain;
  branch: MemoryBranchKind;
  parentId?: string;
  scope: MemoryScope;
  scopeKey?: string;
  tier: InjectionTier;
  statementKind: StatementKind;
  epistemicStatus: EpistemicStatus;
  authorityScope: AuthorityScope;
  assertedBy: MemoryActorRef;
  evidenceRefs: string[];
  entityRefs: string[];
  relationRefs: string[];
  title: string;
  summary: string;
  content: string;
  retrievalKeys: string[];
  importance: number;
  confidence: number;
  basePriority: number;
  verifiedUsefulness: MemoryVerifiedUsefulness;
  feedbackRevision: number;
  lastUsefulAt?: string;
  lastVerifiedAt?: string;
  reason: string;
  sourceRunIds: string[];
  sourceStages: MemoryWriteStage[];
  status: MemoryAtomStatus;
  resolutionStatus: MemoryResolutionStatus;
  invalidation?: MemoryAtomInvalidation | null;
  merge?: MemoryAtomMerge | null;
  mergedFromAtomIds?: string[];
  effectiveAt?: string;
  expiresAt?: string;
  revalidateAt?: string;
  createdAt: string;
  updatedAt: string;
  contentHash: string;
}

export type CreateMemoryAtomInput = Omit<
  MemoryAtom,
  'version' | 'revision' | 'createdAt' | 'updatedAt' | 'contentHash'
> & {
  createdAt?: string;
  updatedAt?: string;
};

export type MemoryAtomPatch = Partial<Omit<
  MemoryAtom,
  'version' | 'id' | 'revision' | 'branch' | 'scope' | 'scopeKey' | 'createdAt' | 'updatedAt' | 'contentHash'
>>;

export type MemoryStorageMutation =
  | { kind: 'create'; atom: CreateMemoryAtomInput }
  | { kind: 'update'; atomId: string; expectedRevision: number; patch: MemoryAtomPatch }
  | { kind: 'archive'; atomId: string; expectedRevision: number }
  | { kind: 'restore'; atomId: string; expectedRevision: number }
  | {
      kind: 'merge';
      targetAtomId: string;
      targetExpectedRevision: number;
      targetPatch: MemoryAtomPatch;
      sourceAtomId: string;
      sourceExpectedRevision: number;
      sourcePatch: MemoryAtomPatch;
    };

/**
 * Immutable source-of-truth record captured before a Memory v3 projection is
 * changed. Recovery journals may be pruned; these fact records may not.
 */
export interface MemoryImmutableFact {
  version: typeof MEMORY_IMMUTABLE_FACT_VERSION;
  id: string;
  idempotencyKey: string;
  event: MemoryUpdateEvent;
  mutation: MemoryStorageMutation;
  atomIds: string[];
  capturedAt: string;
  contentHash: string;
}

export type MemoryEmbeddingStatus = 'disabled' | 'pending' | 'ready' | 'stale' | 'failed';

export interface MemoryCatalogEntry {
  atomId: string;
  filePath: string;
  revision: number;
  domain: MemoryDomain;
  branch: MemoryBranchKind;
  parentId?: string;
  scope: MemoryScope;
  scopeKey?: string;
  tier: InjectionTier;
  statementKind: StatementKind;
  epistemicStatus: EpistemicStatus;
  status: MemoryAtomStatus;
  resolutionStatus: MemoryResolutionStatus;
  contentHash: string;
  embeddingStatus: MemoryEmbeddingStatus;
  embeddingEngineId?: string;
  embeddingModelId?: string;
  embeddingDimensions?: number;
  createdAt: string;
  updatedAt: string;
}

export type MemoryEntityType =
  | 'user'
  | 'project'
  | 'directory'
  | 'file'
  | 'session'
  | 'task'
  | 'skill'
  | 'tool'
  | 'rule'
  | 'concept'
  | 'external-source';

export interface MemoryEntity {
  version: 1;
  id: string;
  type: MemoryEntityType;
  owner: MemoryActorRef;
  scope: MemoryScope | 'run';
  scopeKey?: string;
  externalKey?: string;
  label: string;
  aliases: string[];
  status: 'active' | 'archived' | 'merged' | 'deleted';
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type MemoryRelationType =
  | 'belongs-to'
  | 'depends-on'
  | 'references'
  | 'conflicts-with'
  | 'replaces'
  | 'derived-from'
  | 'similar-to'
  | 'affects'
  | 'supported-by';

export interface MemoryRelation {
  version: 1;
  id: string;
  fromEntityId: string;
  toEntityId: string;
  type: MemoryRelationType;
  scope: MemoryScope;
  scopeKey?: string;
  source: MemoryActorRef;
  evidenceRefs: string[];
  confidence: number;
  authorityScope: AuthorityScope;
  relevance: number;
  effectiveAt?: string;
  expiresAt?: string;
  status: 'proposed' | 'active' | 'disputed' | 'archived' | 'deleted';
  resolutionStatus: MemoryResolutionStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type MemoryUpdateEventKind =
  | 'user-statement'
  | 'user-correction'
  | 'task-state'
  | 'tool-evidence'
  | 'verify-result'
  | 'resource-change'
  | 'agent-capability-change'
  | 'configuration-change'
  | 'conflict-resolution'
  | 'permission-decision'
  | 'time-due';

export interface MemoryUpdateEvent {
  version: typeof MEMORY_EVENT_VERSION;
  id: string;
  idempotencyKey: string;
  kind: MemoryUpdateEventKind;
  domain: MemoryDomain;
  scope: MemoryScope;
  scopeKey?: string;
  atomId?: string;
  expectedAtomRevision?: number;
  source: MemoryActorRef;
  occurredAt: string;
  observedAt: string;
  evidenceRefs: string[];
  payload: Record<string, unknown>;
}

export type MemoryJournalState = 'pending' | 'committed' | 'recovery';

export interface MemoryEventJournalRecord {
  event: MemoryUpdateEvent;
  state: MemoryJournalState;
  attempts: number;
  operationId?: string;
  lastError?: string;
  capturedAt: string;
  updatedAt: string;
}

export type MemoryOperationKind = 'create' | 'update' | 'archive' | 'restore' | 'merge' | 'rebuild';

export interface MemoryOperationRecord {
  version: typeof MEMORY_OPERATION_VERSION;
  id: string;
  idempotencyKey: string;
  kind: MemoryOperationKind;
  atomIds: string[];
  eventIds: string[];
  expectedRevisions: Record<string, number>;
  state: MemoryJournalState;
  attempts: number;
  lastError?: string;
  startedAt: string;
  updatedAt: string;
  committedAt?: string;
}

export interface MemoryAccessRecord {
  id: string;
  atomId: string;
  runId: string;
  stage: string;
  path: 'root-index' | 'branch-index' | 'hierarchy' | 'fts' | 'vector';
  matchReason: string;
  enteredContext: boolean;
  disclosureLevel: MemoryDisclosureLevel;
  tokensUsed: number;
  accessedAt: string;
}

export interface MemoryUseFeedback {
  id: string;
  atomId: string;
  runId: string;
  outcome: MemoryUseOutcome;
  verified: boolean;
  evidenceRefs: string[];
  verifyStageId?: string;
  reason: string;
  createdAt: string;
}

export interface MemoryEvidenceEnvelope {
  atomId: string;
  atomRevision: number;
  branch: MemoryBranchKind;
  scope: MemoryScope;
  scopeKey?: string;
  tier: InjectionTier;
  disclosureLevel: MemoryDisclosureLevel;
  statementKind: StatementKind;
  epistemicStatus: EpistemicStatus;
  authorityScope: AuthorityScope;
  assertedBy: MemoryActorRef;
  evidenceRefs: string[];
  confidence: number;
  importance: number;
  verifiedUsefulness: MemoryVerifiedUsefulness;
  updatedAt: string;
  lastVerifiedAt?: string;
  retrievalPath: Extract<MemoryAccessRecord['path'], 'hierarchy' | 'fts' | 'vector'>;
  matchReason: string;
  conflict: boolean;
  expired: boolean;
  truncated: boolean;
}

export type KnownStateMemoryDecision = 'adopted' | 'excluded' | 'conflicted';

export interface KnownStateMemoryReference {
  atomId: string;
  atomRevision: number;
  evidenceRefs: string[];
  decision: KnownStateMemoryDecision;
  reason: string;
  envelope: MemoryEvidenceEnvelope;
  stages: string[];
  firstSeenAt: string;
  updatedAt: string;
  reactivatedCount: number;
}

/** Versioned run-local record of memory evidence that may influence later stages. */
export interface MemoryKnownState {
  version: 1;
  runId: string;
  revision: number;
  updatedAt: string;
  references: KnownStateMemoryReference[];
}

export interface MemoryRelationNeighborhood {
  entities: MemoryEntity[];
  relations: MemoryRelation[];
  truncated: boolean;
}

export interface MemoryAtomHistoryEntry {
  kind: 'access' | 'feedback' | 'event' | 'audit';
  id: string;
  at: string;
  summary: string;
}

export interface MemoryAtomHistory {
  atomId: string;
  revision: number;
  sourceRunIds: string[];
  sourceStages: MemoryWriteStage[];
  entries: MemoryAtomHistoryEntry[];
  truncated: boolean;
}

export interface MemoryCandidatePriorityInput {
  atom: MemoryAtom;
  now: string;
  scopeMatch: number;
  taskRelevance: number;
  authorityMatch: number;
  verifiedUsefulness: number;
  decayHalfLifeDays: number;
  requiredByCurrentUser: boolean;
  safetyCritical: boolean;
}

export interface MemoryCandidatePriorityBreakdown {
  score: number;
  eligible: boolean;
  protected: boolean;
  freshness: number;
  usefulnessDecay: number;
  penalties: string[];
  factors: Record<string, number>;
}

export interface EmbeddingEngineDescriptor {
  engineId: string;
  modelId: string;
  version: string;
  dimensions: number;
  transport: 'local' | 'remote' | 'test';
}

export interface EmbeddingRequest {
  texts: string[];
  purpose: 'document' | 'query' | 'benchmark';
  signal?: AbortSignal;
}

export interface EmbeddingResult {
  vectors: number[][];
  descriptor: EmbeddingEngineDescriptor;
}

export interface EmbeddingEngine {
  readonly descriptor: EmbeddingEngineDescriptor;
  isAvailable(): boolean | Promise<boolean>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export interface MemoryCatalogScope {
  branch: MemoryBranchKind;
  scope: MemoryScope;
  scopeKey?: string;
  subtreeRootId?: string;
}

export interface MemoryCatalogSearchOptions extends MemoryCatalogScope {
  limit?: number;
  includeArchived?: boolean;
}

export interface MemoryCatalogSearchResult {
  entry: MemoryCatalogEntry;
  score: number;
  matchReason: 'fts' | 'vector';
}

export interface MemoryDueRecord {
  atomId: string;
  kind: 'effective' | 'expiry' | 'revalidate' | 'usefulness-decay';
  dueAt: string;
}
