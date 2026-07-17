// Owns the versioned Memory v3 storage, epistemic, evidence, graph, and embedding contracts.

import type { AtomicActivationSnapshot } from '@littlesheep/types';
import type { InjectionTier, MemoryBranchKind, MemoryScope, MemoryWriteStage } from '../types.js';
import type {
  AuthorityScope,
  EpistemicStatus,
  MemoryActorRef,
  MemoryDomain,
  MemoryEntityType,
  MemoryRelationType,
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
  MemoryEntityType,
  MemoryRelationType,
  MemoryWriteEntityHint,
  MemoryWriteEpistemicMetadata,
  MemoryWriteRelationHint,
  StatementKind,
} from '../epistemic.js';

export const MEMORY_ATOM_VERSION = 3 as const;
export const MEMORY_EVENT_VERSION = 1 as const;
export const MEMORY_OPERATION_VERSION = 1 as const;
export const MEMORY_PROJECTION_RECORD_VERSION = 1 as const;
export const MEMORY_PROJECTION_RECORD_COMMIT_VERSION = 1 as const;
export const MEMORY_VECTOR_NAMESPACE = 'memory-atom' as const;
/** @deprecated Internal compatibility alias. Use projection-record terminology. */
export const MEMORY_RAW_RECORD_VERSION = MEMORY_PROJECTION_RECORD_VERSION;
/** @deprecated Internal compatibility alias. Use projection-record terminology. */
export const MEMORY_RAW_RECORD_COMMIT_VERSION = MEMORY_PROJECTION_RECORD_COMMIT_VERSION;

export type MemoryDisclosureLevel = 'D0' | 'D1' | 'D2' | 'D3';

export type MemoryAtomRetrievalPath = 'hierarchy' | 'fts' | 'vector' | 'relation';
export type MemoryRelationRouteDirection = 'outbound' | 'inbound' | 'shared';

export interface MemoryRelationRouteEvidence {
  seedAtomId: string;
  relationId: string;
  relationType: MemoryRelationType;
  direction: MemoryRelationRouteDirection;
  confidence: number;
  relevance: number;
  strength: number;
}

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

/**
 * Bounded routing evidence used only to decide whether an atom should be
 * admitted into future run contexts. It never changes epistemic confidence.
 */
export interface MemoryRoutingFeedback {
  useful: number;
  notUseful: number;
  conflicts: number;
  stale: number;
  /**
   * Derived routing score at lastRoutedAt. This remains separate from
   * epistemic confidence and decays back toward neutral between observations.
   */
  effectiveRelevance?: number;
  /** Bounded effective observation weight used to prevent old feedback revival. */
  effectiveEvidenceWeight?: number;
  lastOutcome?: MemoryUseOutcome;
  lastRoutedAt?: string;
  recentFeedbackIds?: string[];
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
  sourceRefs: string[];
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
  routingFeedback?: MemoryRoutingFeedback;
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
  mergedIntentIds?: string[];
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
 * Append-only projection mutation record captured before a Memory v3 atom changes.
 * It exists for idempotency, audit and crash recovery. It is not user-visible
 * conversation source data and must never be presented as such.
 */
export interface MemoryProjectionMutationRecord {
  version: typeof MEMORY_PROJECTION_RECORD_VERSION;
  id: string;
  idempotencyKey: string;
  event: MemoryUpdateEvent;
  mutation: MemoryStorageMutation;
  atomIds: string[];
  capturedAt: string;
  contentHash: string;
}

/** @deprecated Internal compatibility alias. */
export type MemoryRawRecord = MemoryProjectionMutationRecord;

/**
 * Append-only proof that one projection mutation record reached the committed
 * boundary. The receipt is separate so the mutation record never needs to be
 * edited after capture.
 */
export interface MemoryProjectionMutationCommitReceipt {
  version: typeof MEMORY_PROJECTION_RECORD_COMMIT_VERSION;
  rawRecordId: string;
  rawRecordContentHash: string;
  operationId: string;
  committedAt: string;
  contentHash: string;
}

/** @deprecated Internal compatibility alias. */
export type MemoryRawRecordCommitReceipt = MemoryProjectionMutationCommitReceipt;

export type MemoryEmbeddingStatus = 'disabled' | 'pending' | 'ready' | 'stale' | 'failed';
export type MemoryVectorNamespace = typeof MEMORY_VECTOR_NAMESPACE;

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
  embeddingHash: string;
  vectorNamespace: MemoryVectorNamespace;
  embeddingStatus: MemoryEmbeddingStatus;
  embeddingEngineId?: string;
  embeddingModelId?: string;
  embeddingDimensions?: number;
  activationScore: number;
  activationUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

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

export interface MemoryRelation {
  version: 1;
  id: string;
  fromEntityId: string;
  toEntityId: string;
  type: MemoryRelationType;
  scope: MemoryScope;
  scopeKey?: string;
  source: MemoryActorRef;
  sourceRefs: string[];
  evidenceRefs: string[];
  confidence: number;
  authorityScope: AuthorityScope;
  relevance: number;
  feedbackRevision?: number;
  recentFeedbackIds?: string[];
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
  sourceRefs: string[];
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
  path: 'root-index' | 'branch-index' | MemoryAtomRetrievalPath;
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
  sourceRefs: string[];
  evidenceRefs: string[];
  confidence: number;
  importance: number;
  verifiedUsefulness: MemoryVerifiedUsefulness;
  taskRelevance: number;
  routingRelevance: number;
  relationshipRelevance: number;
  activation: AtomicActivationSnapshot;
  updatedAt: string;
  lastVerifiedAt?: string;
  retrievalPath: MemoryAtomRetrievalPath;
  relationRoute?: MemoryRelationRouteEvidence;
  matchReason: string;
  conflict: boolean;
  expired: boolean;
  truncated: boolean;
}

export type KnownStateMemoryDecision = 'adopted' | 'excluded' | 'conflicted';

export interface KnownStateMemoryReference {
  atomId: string;
  atomRevision: number;
  sourceRefs: string[];
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
  routingRelevance: number;
  relationshipRelevance: number;
  decayHalfLifeDays: number;
  requiredByCurrentUser: boolean;
  safetyCritical: boolean;
}

export interface MemoryCandidatePriorityBreakdown {
  score: number;
  eligible: boolean;
  protected: boolean;
  taskRelevance: number;
  freshness: number;
  usefulnessDecay: number;
  routingRelevance: number;
  routingMultiplier: number;
  relationshipRelevance: number;
  relationshipMultiplier: number;
  activation: AtomicActivationSnapshot;
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
