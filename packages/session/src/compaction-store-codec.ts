// Validates durable session compaction transactions, projections, and activation records.

import type {
  AtomicActivationEvidence,
  CompactionSummaryV2,
} from '@littlesheep/types';

export const COMPACTION_TRANSACTION_VERSION = 1 as const;
export const SESSION_SUMMARY_ACTIVATION_VERSION = 1 as const;

export interface PendingCompactionTransaction {
  version: typeof COMPACTION_TRANSACTION_VERSION;
  sessionId: string;
  summary: CompactionSummaryV2;
  createdAt: string;
}

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
  if (value.version !== COMPACTION_TRANSACTION_VERSION
    || value.sessionId !== sessionId
    || typeof value.createdAt !== 'string'
    || !isCompactionSummaryV2(value.summary)) {
    throw new Error('Invalid pending session compaction transaction.');
  }
  return value as PendingCompactionTransaction;
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
