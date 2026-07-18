// Runtime-owned hierarchy correction for model-proposed Atom parent changes.
// The model identifies an explicit semantic relation; Runtime owns all state,
// relation, revision, leaf, scope, cycle, commit and recovery validation.

import type { MemoryRepositoryManagementFacade } from './memory-repository/management.js';
import type { MemoryBranchKind } from './types.js';
import type {
  MemoryAtomHierarchyResult,
  MemoryAtomHierarchyServiceLike,
  MemoryAtomReparentProposal,
} from './memory-hierarchy-contracts.js';
import {
  MAX_HIERARCHY_PROPOSALS,
  explicitParentRelation,
  hierarchyErrorMessage,
  hierarchyFailureStatus,
  hierarchyReason,
  hierarchyResult,
  validateAtomReparentBoundary,
  validateReparentProposal,
} from './memory-hierarchy-validation.js';

export type {
  MemoryAtomHierarchyResult,
  MemoryAtomHierarchyServiceLike,
  MemoryAtomHierarchyStatus,
  MemoryAtomReparentProposal,
} from './memory-hierarchy-contracts.js';

export interface MemoryAtomHierarchyServiceOptions {
  management: MemoryRepositoryManagementFacade;
  invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;
}

export class MemoryAtomHierarchyService implements MemoryAtomHierarchyServiceLike {
  private readonly management: MemoryRepositoryManagementFacade;
  private readonly invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;

  constructor(options: MemoryAtomHierarchyServiceOptions) {
    this.management = options.management;
    this.invalidate = options.invalidate;
  }

  async reparent(proposals: readonly MemoryAtomReparentProposal[]): Promise<MemoryAtomHierarchyResult[]> {
    const bounded = proposals.slice(0, MAX_HIERARCHY_PROPOSALS);
    const status = await this.management.status();
    if (status.backendKind !== 'v3') {
      return bounded.map((proposal) => hierarchyResult(proposal, 'deferred', 'Memory v3 hierarchy management is unavailable.'));
    }
    const results: MemoryAtomHierarchyResult[] = [];
    for (const proposal of bounded) results.push(await this.reparentOne(proposal));
    return results;
  }

  private async reparentOne(proposal: MemoryAtomReparentProposal): Promise<MemoryAtomHierarchyResult> {
    const invalid = validateReparentProposal(proposal);
    if (invalid) return hierarchyResult(proposal, 'rejected', invalid);
    const [atomInspection, parentInspection] = await Promise.all([
      this.management.inspectNode(proposal.atom.atomId, 'D3'),
      this.management.inspectNode(proposal.parent.atomId, 'D3'),
    ]);
    const atom = atomInspection?.atom;
    const parent = parentInspection?.atom;
    if (!atom) return hierarchyResult(proposal, 'rejected', `Memory atom was not found: ${proposal.atom.atomId}.`);
    if (!parent) return hierarchyResult(proposal, 'rejected', `Destination parent was not found: ${proposal.parent.atomId}.`);
    if (parent.revision !== proposal.parent.expectedRevision) {
      return hierarchyResult(proposal, 'rejected', `Destination parent ${parent.id} revision changed before hierarchy reconciliation.`);
    }
    const alreadyApplied = atom.parentId === parent.id
      && (atom.revision === proposal.atom.expectedRevision || atom.revision === proposal.atom.expectedRevision + 1);
    if (!alreadyApplied && atom.revision !== proposal.atom.expectedRevision) {
      return hierarchyResult(proposal, 'rejected', `Memory atom ${atom.id} revision changed before hierarchy reconciliation.`);
    }
    const boundary = validateAtomReparentBoundary(atom, parent);
    if (boundary) return hierarchyResult(proposal, 'rejected', boundary);
    if (atomInspection?.hasActiveChildren) {
      return hierarchyResult(proposal, 'rejected', `Memory atom ${atom.id} has active children and cannot be moved automatically.`);
    }
    if (alreadyApplied) {
      if (atom.revision === proposal.atom.expectedRevision + 1) await this.invalidate?.(atom.branch);
      return hierarchyResult(proposal, 'noop', `Memory atom ${atom.id} already belongs to ${parent.id}.`);
    }
    const relation = explicitParentRelation(
      atom,
      parent,
      proposal.relationId,
      atomInspection?.neighborhood,
      parentInspection?.neighborhood,
    );
    if (!relation) {
      return hierarchyResult(
        proposal,
        'rejected',
        `No active, resolved and evidenced parent relation connects ${atom.id} to ${parent.id}.`,
      );
    }

    try {
      const result = await this.management.manageAtom({
        action: 'move',
        atomId: atom.id,
        expectedRevision: atom.revision,
        parentNodeId: parent.id,
        reason: hierarchyReason(proposal),
      });
      await this.invalidate?.(atom.branch);
      return hierarchyResult(
        proposal,
        'committed',
        `Moved ${atom.id} under ${parent.id} using ${relation.type} relation ${relation.id}.`,
        [result],
      );
    } catch (error) {
      return hierarchyResult(
        proposal,
        hierarchyFailureStatus(error),
        `Hierarchy reconciliation failed: ${hierarchyErrorMessage(error)}`,
      );
    }
  }
}
