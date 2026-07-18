import type { MemoryAtomManagementResult } from './memory-repository/management.js';
import type { MemoryAtomRevisionReference } from './memory-reconciliation-contracts.js';

/** Hard automatic-mutation ceiling; a larger subtree needs explicit user governance. */
export const MAX_SUBTREE_ACTIVE_DESCENDANTS = 128;

/**
 * A model may propose moving one existing non-leaf Atom as a subtree root.
 * Runtime owns scope, relation, size, cycle, revision and commit validation.
 */
export interface MemoryAtomSubtreeMoveProposal {
  id: string;
  action: 'move-subtree';
  basis: 'explicit-parent-relation';
  root: MemoryAtomRevisionReference;
  parent: MemoryAtomRevisionReference;
  relationId: string;
  reason: string;
  evidenceRefs: string[];
}

export type MemoryAtomSubtreeStatus = 'committed' | 'noop' | 'rejected' | 'deferred';

export interface MemoryAtomSubtreeResult {
  proposalId: string;
  status: MemoryAtomSubtreeStatus;
  rootAtomId: string;
  parentAtomId: string;
  activeDescendantCount?: number;
  committed: boolean;
  reason: string;
  managementResults: MemoryAtomManagementResult[];
}

export interface MemoryAtomSubtreeServiceLike {
  moveSubtrees(proposals: readonly MemoryAtomSubtreeMoveProposal[]): Promise<MemoryAtomSubtreeResult[]>;
}
