// Validates durable session compaction transactions, projections, and activation records.

import type {
  AtomicActivationEvidence,
  CompactionSummaryV2,
} from '@littlesheep/types';

export const COMPACTION_TRANSACTION_VERSION = 2 as const;
export const LEGACY_COMPACTION_TRANSACTION_VERSION = 1 as const;
export const SESSION_SUMMARY_ACTIVATION_VERSION = 1 as const;

export interface CompactionCommitPrecondition {
  expectedPreviousSummaryId: string | null;
  sourceEndMessageId: string;
  sourceHash: string;
  policyVersion: number;
  transactionKey: string;
}

export type CompactionMemoryCandidateBranch = 'long-term' | 'project' | 'experience';
export type CompactionMemoryCandidateScope = 'global' | 'workspace' | 'project';

export interface CompactionMemoryCandidate {
  id: string;
  branch: CompactionMemoryCandidateBranch;
  parentNodeId: string;
  scope: CompactionMemoryCandidateScope;
  scopeKey?: string;
  summary: string;
  content: string;
  retrievalKeys: string[];
  sourceMessageIds: string[];
  importance: number;
  confidence: number;
  reason: string;
  epistemic?: Record<string, unknown>;
}

export interface CompactionMemoryCandidateOutcome {
  candidateId: string;
  status: 'committed' | 'rejected' | 'superseded';
  reason: string;
  nodeId?: string;
  updatedAt: string;
}

export interface CompactionMemoryProposal {
  version: 1;
  requestId?: string;
  evidenceComplete: boolean;
  candidates: CompactionMemoryCandidate[];
  outcomes: CompactionMemoryCandidateOutcome[];
  /**
   * Set when the proposal was explicitly terminated instead of settled (RS-05). Compaction no longer
   * writes durable memory, so a proposal left pending by an older build is closed with this stamp and
   * its audit kept — the stamp is also what makes re-running the termination a no-op.
   */
  terminatedAt?: string;
  terminationReason?: string;
}

export interface PendingCompactionTransactionV1 {
  version: typeof LEGACY_COMPACTION_TRANSACTION_VERSION;
  sessionId: string;
  summary: CompactionSummaryV2;
  createdAt: string;
}

export interface PendingCompactionTransactionV2 {
  version: typeof COMPACTION_TRANSACTION_VERSION;
  sessionId: string;
  summary: CompactionSummaryV2;
  precondition: CompactionCommitPrecondition;
  memoryProposal?: CompactionMemoryProposal;
  summaryCommittedAt?: string;
  createdAt: string;
}

export type PendingCompactionTransaction = PendingCompactionTransactionV1 | PendingCompactionTransactionV2;

export interface SessionSummaryActivationRecord {
  version: typeof SESSION_SUMMARY_ACTIVATION_VERSION;
  namespace: 'session-summary';
  sessionId: string;
  summaryId: string;
  createdAt: string;
  updatedAt: string;
  evidence: AtomicActivationEvidence;
}

export function isActivationRecord(value: unknown): value is SessionSummaryActivationRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SessionSummaryActivationRecord>;
  const evidence = record.evidence as Partial<AtomicActivationEvidence> | undefined;
  return record.version === SESSION_SUMMARY_ACTIVATION_VERSION
    && record.namespace === 'session-summary'
    && typeof record.sessionId === 'string'
    && typeof record.summaryId === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
    && evidence?.version === 1
    && Array.isArray(evidence.recentEventIds);
}

export function parsePendingTransaction(raw: string, sessionId: string): PendingCompactionTransaction {
  const value = JSON.parse(raw) as Partial<PendingCompactionTransaction>;
  if ((value.version !== COMPACTION_TRANSACTION_VERSION && value.version !== LEGACY_COMPACTION_TRANSACTION_VERSION)
    || value.sessionId !== sessionId
    || typeof value.createdAt !== 'string'
    || !isCompactionSummaryV2(value.summary)) {
    throw new Error('Invalid pending session compaction transaction.');
  }
  if (value.version === COMPACTION_TRANSACTION_VERSION && !isCommitPrecondition(value.precondition)) {
    throw new Error('Invalid pending session compaction precondition.');
  }
  if (value.version === COMPACTION_TRANSACTION_VERSION
    && value.memoryProposal !== undefined
    && !isMemoryProposal(value.memoryProposal)) {
    throw new Error('Invalid pending session compaction memory proposal.');
  }
  return value as PendingCompactionTransaction;
}

function isMemoryProposal(value: unknown): value is CompactionMemoryProposal {
  if (!value || typeof value !== 'object') return false;
  const proposal = value as Partial<CompactionMemoryProposal>;
  return proposal.version === 1
    && typeof proposal.evidenceComplete === 'boolean'
    && (proposal.requestId === undefined || typeof proposal.requestId === 'string')
    && Array.isArray(proposal.candidates)
    && proposal.candidates.length <= 8
    && proposal.candidates.every(isMemoryCandidate)
    && Array.isArray(proposal.outcomes)
    && proposal.outcomes.every(isMemoryCandidateOutcome);
}

function isMemoryCandidate(value: unknown): value is CompactionMemoryCandidate {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CompactionMemoryCandidate>;
  return typeof item.id === 'string'
    && ['long-term', 'project', 'experience'].includes(String(item.branch))
    && typeof item.parentNodeId === 'string'
    && ['global', 'workspace', 'project'].includes(String(item.scope))
    && (item.scopeKey === undefined || typeof item.scopeKey === 'string')
    && typeof item.summary === 'string'
    && item.summary.length <= 240
    && typeof item.content === 'string'
    && item.content.length <= 4_000
    && Array.isArray(item.retrievalKeys)
    && item.retrievalKeys.length <= 16
    && item.retrievalKeys.every((entry) => typeof entry === 'string')
    && Array.isArray(item.sourceMessageIds)
    && item.sourceMessageIds.length <= 32
    && item.sourceMessageIds.every((entry) => typeof entry === 'string')
    && typeof item.importance === 'number'
    && item.importance >= 0
    && item.importance <= 1
    && typeof item.confidence === 'number'
    && item.confidence >= 0
    && item.confidence <= 1
    && typeof item.reason === 'string';
}

function isMemoryCandidateOutcome(value: unknown): value is CompactionMemoryCandidateOutcome {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CompactionMemoryCandidateOutcome>;
  return typeof item.candidateId === 'string'
    && ['committed', 'rejected', 'superseded'].includes(String(item.status))
    && typeof item.reason === 'string'
    && typeof item.updatedAt === 'string'
    && (item.nodeId === undefined || typeof item.nodeId === 'string');
}

function isCommitPrecondition(value: unknown): value is CompactionCommitPrecondition {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<CompactionCommitPrecondition>;
  return (item.expectedPreviousSummaryId === null || typeof item.expectedPreviousSummaryId === 'string')
    && typeof item.sourceEndMessageId === 'string'
    && typeof item.sourceHash === 'string'
    && Number.isSafeInteger(item.policyVersion)
    && item.policyVersion! > 0
    && typeof item.transactionKey === 'string'
    && item.transactionKey.length > 0;
}

export function isCompactionSummaryV2(value: unknown): value is CompactionSummaryV2 {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<CompactionSummaryV2>;
  const sourceRunIdsValid = summary.sourceRunIds === undefined
    || (Array.isArray(summary.sourceRunIds)
      && summary.sourceRunIds.length <= 64
      && summary.sourceRunIds.every((runId) => typeof runId === 'string' && runId.trim().length > 0));
  return summary.version === 2
    && typeof summary.id === 'string'
    && typeof summary.summary === 'string'
    && summary.cache?.namespace === 'session-summary'
    && summary.cache.compressionDepth >= 1
    && summary.cache.compressionDepth <= 3
    && Array.isArray(summary.sourceRanges)
    && Array.isArray(summary.sourceSummaryIds)
    && sourceRunIdsValid
    && (summary.sourceRunIdsTruncated === undefined || typeof summary.sourceRunIdsTruncated === 'boolean')
    && typeof summary.sourceHash === 'string'
    && typeof summary.lineageHash === 'string';
}
