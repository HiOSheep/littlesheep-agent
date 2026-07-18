import type { MemoryAtomManagementResult } from './memory-repository/management.js';

export interface MemoryAtomRevisionReference {
  atomId: string;
  expectedRevision: number;
}

/**
 * A model may propose a duplicate projection merge only after it has seen the
 * relevant D2 atoms. Runtime adds the run evidence and validates every field
 * before calling the atom management facade.
 */
export interface MemoryAtomMergeProposal {
  id: string;
  action: 'merge';
  basis: 'duplicate-projection';
  target: MemoryAtomRevisionReference;
  sources: MemoryAtomRevisionReference[];
  reason: string;
  evidenceRefs: string[];
}

export type MemoryAtomReconciliationProposal = MemoryAtomMergeProposal;

export type MemoryAtomReconciliationStatus =
  | 'committed'
  | 'partial'
  | 'noop'
  | 'rejected'
  | 'deferred';

export interface MemoryAtomReconciliationResult {
  proposalId: string;
  status: MemoryAtomReconciliationStatus;
  targetAtomId: string;
  sourceAtomIds: string[];
  committedSourceAtomIds: string[];
  remainingSourceAtomIds: string[];
  reason: string;
  managementResults: MemoryAtomManagementResult[];
}

export interface MemoryAtomReconciliationServiceLike {
  reconcile(
    proposals: readonly MemoryAtomReconciliationProposal[],
  ): Promise<MemoryAtomReconciliationResult[]>;
}
