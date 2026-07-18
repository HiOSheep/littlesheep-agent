import type { MemoryAtomManagementResult } from './memory-repository/management.js';
import type { MemoryAtomRevisionReference } from './memory-reconciliation-contracts.js';

export type MemoryAtomCorrectionBasis = 'evidence-backed-correction' | 'conflict-replacement';

/**
 * A model may nominate one existing Atom as the active replacement for an
 * older projection. Runtime owns every evidence, authority and storage check.
 */
export interface MemoryAtomCorrectionProposal {
  id: string;
  action: 'supersede';
  basis: MemoryAtomCorrectionBasis;
  superseded: MemoryAtomRevisionReference;
  replacement: MemoryAtomRevisionReference;
  relationId: string;
  reason: string;
  evidenceRefs: string[];
}

export type MemoryAtomCorrectionStatus = 'committed' | 'noop' | 'rejected' | 'deferred';

export interface MemoryAtomCorrectionResult {
  proposalId: string;
  status: MemoryAtomCorrectionStatus;
  supersededAtomId: string;
  replacementAtomId: string;
  committed: boolean;
  previousRevision?: number;
  revision?: number;
  reason: string;
  managementResults: MemoryAtomManagementResult[];
}

export interface MemoryAtomCorrectionServiceLike {
  resolve(proposals: readonly MemoryAtomCorrectionProposal[]): Promise<MemoryAtomCorrectionResult[]>;
}
