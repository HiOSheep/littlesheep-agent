// Runtime-owned non-leaf hierarchy boundary. The model may nominate one
// evidenced subtree root and destination; Runtime owns every structural check.

import type { MemoryRepositoryManagementFacade } from './memory-repository/management.js';
import type { MemoryBranchKind } from './types.js';
import {
  MAX_SUBTREE_ACTIVE_DESCENDANTS,
  type MemoryAtomSubtreeMoveProposal,
  type MemoryAtomSubtreeResult,
  type MemoryAtomSubtreeServiceLike,
} from './memory-subtree-contracts.js';
import {
  MAX_SUBTREE_PROPOSALS,
  explicitSubtreeParentRelation,
  subtreeErrorMessage,
  subtreeFailureStatus,
  subtreeMoveReason,
  subtreeResult,
  validateSubtreeBoundary,
  validateSubtreeMoveProposal,
} from './memory-subtree-validation.js';

export type {
  MemoryAtomSubtreeMoveProposal,
  MemoryAtomSubtreeResult,
  MemoryAtomSubtreeServiceLike,
  MemoryAtomSubtreeStatus,
} from './memory-subtree-contracts.js';
export {
  MAX_SUBTREE_ACTIVE_DESCENDANTS,
  MAX_SUBTREE_PROPOSALS,
};

export interface MemoryAtomSubtreeServiceOptions {
  management: MemoryRepositoryManagementFacade;
  invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;
}

export class MemoryAtomSubtreeService implements MemoryAtomSubtreeServiceLike {
  private readonly management: MemoryRepositoryManagementFacade;
  private readonly invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;

  constructor(options: MemoryAtomSubtreeServiceOptions) {
    this.management = options.management;
    this.invalidate = options.invalidate;
  }

  async moveSubtrees(
    proposals: readonly MemoryAtomSubtreeMoveProposal[],
  ): Promise<MemoryAtomSubtreeResult[]> {
    const bounded = proposals.slice(0, MAX_SUBTREE_PROPOSALS);
    const status = await this.management.status();
    if (status.backendKind !== 'v3') {
      return bounded.map((proposal) => subtreeResult(
        proposal,
        'deferred',
        'Memory v3 subtree management is unavailable.',
      ));
    }
    const results: MemoryAtomSubtreeResult[] = [];
    for (const proposal of bounded) results.push(await this.moveOne(proposal));
    return results;
  }

  private async moveOne(proposal: MemoryAtomSubtreeMoveProposal): Promise<MemoryAtomSubtreeResult> {
    const invalid = validateSubtreeMoveProposal(proposal);
    if (invalid) return subtreeResult(proposal, 'rejected', invalid);

    const [rootInspection, parentInspection] = await Promise.all([
      this.management.inspectNode(proposal.root.atomId, 'D3'),
      this.management.inspectNode(proposal.parent.atomId, 'D3'),
    ]);
    const root = rootInspection?.atom;
    const parent = parentInspection?.atom;
    if (!root) {
      return subtreeResult(proposal, 'rejected', `Memory subtree root was not found: ${proposal.root.atomId}.`);
    }
    if (!parent) {
      return subtreeResult(proposal, 'rejected', `Destination parent was not found: ${proposal.parent.atomId}.`);
    }
    if (parent.revision !== proposal.parent.expectedRevision) {
      return subtreeResult(
        proposal,
        'rejected',
        `Destination parent ${parent.id} revision changed before subtree reconciliation.`,
      );
    }
    const alreadyApplied = root.parentId === parent.id
      && (root.revision === proposal.root.expectedRevision
        || root.revision === proposal.root.expectedRevision + 1);
    if (!alreadyApplied && root.revision !== proposal.root.expectedRevision) {
      return subtreeResult(
        proposal,
        'rejected',
        `Memory subtree root ${root.id} revision changed before reconciliation.`,
      );
    }
    const boundary = validateSubtreeBoundary(root, parent);
    if (boundary) return subtreeResult(proposal, 'rejected', boundary);

    const descendantCount = rootInspection?.activeDescendantCount;
    if (descendantCount === undefined) {
      return subtreeResult(
        proposal,
        'deferred',
        `Memory subtree root ${root.id} has no bounded descendant inspection.`,
      );
    }
    if (descendantCount < 1) {
      return subtreeResult(
        proposal,
        'rejected',
        `Memory atom ${root.id} has no active descendants; use the leaf hierarchy protocol instead.`,
        descendantCount,
      );
    }
    if (descendantCount > MAX_SUBTREE_ACTIVE_DESCENDANTS) {
      return subtreeResult(
        proposal,
        'rejected',
        `Memory subtree ${root.id} exceeds the automatic limit of ${MAX_SUBTREE_ACTIVE_DESCENDANTS} active descendants.`,
        descendantCount,
      );
    }
    if (alreadyApplied) {
      if (root.revision === proposal.root.expectedRevision + 1) await this.invalidate?.(root.branch);
      return subtreeResult(
        proposal,
        'noop',
        `Memory subtree ${root.id} already belongs to ${parent.id}.`,
        descendantCount,
      );
    }

    const relation = explicitSubtreeParentRelation(
      root,
      parent,
      proposal.relationId,
      rootInspection?.neighborhood,
      parentInspection?.neighborhood,
    );
    if (!relation) {
      return subtreeResult(
        proposal,
        'rejected',
        `No active, resolved and evidenced parent relation connects subtree ${root.id} to ${parent.id}.`,
        descendantCount,
      );
    }

    try {
      const result = await this.management.manageAtom({
        action: 'move',
        atomId: root.id,
        expectedRevision: root.revision,
        parentNodeId: parent.id,
        reason: subtreeMoveReason(proposal),
      });
      await this.invalidate?.(root.branch);
      return subtreeResult(
        proposal,
        'committed',
        `Moved subtree ${root.id} with ${descendantCount} active descendant(s) under ${parent.id} using ${relation.type} relation ${relation.id}.`,
        descendantCount,
        [result],
      );
    } catch (error) {
      return subtreeResult(
        proposal,
        subtreeFailureStatus(error),
        `Subtree reconciliation failed: ${subtreeErrorMessage(error)}`,
        descendantCount,
      );
    }
  }
}
