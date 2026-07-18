import type { MemoryAtomManagementResult } from './memory-repository/management.js';
import type { MemoryAtomRevisionReference } from './memory-reconciliation-contracts.js';

/**
 * A model may propose one semantic parent correction only from Atom and
 * relation evidence already adopted into the current run KnownState.
 */
export interface MemoryAtomReparentProposal {
  id: string;
  action: 'move';
  basis: 'explicit-parent-relation';
  atom: MemoryAtomRevisionReference;
  parent: MemoryAtomRevisionReference;
  relationId: string;
  reason: string;
  evidenceRefs: string[];
}

export type MemoryAtomHierarchyStatus = 'committed' | 'noop' | 'rejected' | 'deferred';

export interface MemoryAtomHierarchyResult {
  proposalId: string;
  status: MemoryAtomHierarchyStatus;
  atomId: string;
  parentAtomId: string;
  committed: boolean;
  reason: string;
  managementResults: MemoryAtomManagementResult[];
}

export interface MemoryAtomHierarchyServiceLike {
  reparent(proposals: readonly MemoryAtomReparentProposal[]): Promise<MemoryAtomHierarchyResult[]>;
}
