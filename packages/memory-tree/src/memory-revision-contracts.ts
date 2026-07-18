import type {
  MemoryAtomManagementResult,
  MemoryAtomRevisionPatch,
} from './memory-repository/management.js';
import type { MemoryAtomRevisionReference } from './memory-reconciliation-contracts.js';

/** A bounded same-claim wording/normalization proposal. */
export interface MemoryAtomRevisionProposal {
  id: string;
  action: 'revise';
  basis: 'same-claim-refinement';
  atom: MemoryAtomRevisionReference;
  replacement: MemoryAtomRevisionPatch;
  reason: string;
  evidenceRefs: string[];
}

export type MemoryAtomRevisionStatus = 'committed' | 'noop' | 'rejected' | 'deferred';

export interface MemoryAtomRevisionResult {
  proposalId: string;
  status: MemoryAtomRevisionStatus;
  atomId: string;
  committed: boolean;
  previousRevision?: number;
  revision?: number;
  reason: string;
  managementResults: MemoryAtomManagementResult[];
}

export interface MemoryAtomRevisionServiceLike {
  revise(proposals: readonly MemoryAtomRevisionProposal[]): Promise<MemoryAtomRevisionResult[]>;
}
