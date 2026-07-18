// Runtime-owned boundary for evidence-preserving Atom projection refinement.
// The model proposes wording; the Runtime owns eligibility, claim-preservation,
// revision checks, persistence, recovery and index invalidation.

import type { MemoryRepositoryManagementFacade } from './memory-repository/management.js';
import type { MemoryBranchKind } from './types.js';
import type {
  MemoryAtomRevisionProposal,
  MemoryAtomRevisionResult,
  MemoryAtomRevisionServiceLike,
} from './memory-revision-contracts.js';
import {
  MAX_REVISION_PROPOSALS,
  projectionMatches,
  revisionErrorMessage,
  revisionFailureStatus,
  revisionReason,
  revisionResult,
  validateAtomRevisionBoundary,
  validateRevisionProposal,
} from './memory-revision-validation.js';

export type {
  MemoryAtomRevisionProposal,
  MemoryAtomRevisionResult,
  MemoryAtomRevisionServiceLike,
  MemoryAtomRevisionStatus,
} from './memory-revision-contracts.js';
export type { MemoryAtomRevisionPatch } from './memory-repository/management.js';
export { MAX_REVISION_PROPOSALS } from './memory-revision-validation.js';

export interface MemoryAtomRevisionServiceOptions {
  management: MemoryRepositoryManagementFacade;
  invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;
}

export class MemoryAtomRevisionService implements MemoryAtomRevisionServiceLike {
  private readonly management: MemoryRepositoryManagementFacade;
  private readonly invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;

  constructor(options: MemoryAtomRevisionServiceOptions) {
    this.management = options.management;
    this.invalidate = options.invalidate;
  }

  async revise(proposals: readonly MemoryAtomRevisionProposal[]): Promise<MemoryAtomRevisionResult[]> {
    const bounded = proposals.slice(0, MAX_REVISION_PROPOSALS);
    const status = await this.management.status();
    if (status.backendKind !== 'v3') {
      return bounded.map((proposal) => revisionResult(proposal, 'deferred', 'Memory v3 Atom revision is unavailable.'));
    }
    const results: MemoryAtomRevisionResult[] = [];
    for (const proposal of bounded) results.push(await this.reviseOne(proposal));
    return results;
  }

  private async reviseOne(proposal: MemoryAtomRevisionProposal): Promise<MemoryAtomRevisionResult> {
    const invalid = validateRevisionProposal(proposal);
    if (invalid) return revisionResult(proposal, 'rejected', invalid);

    const inspection = await this.management.inspectNode(proposal.atom.atomId, 'D3');
    const atom = inspection?.atom;
    if (!atom) return revisionResult(proposal, 'rejected', `Memory atom was not found: ${proposal.atom.atomId}.`);

    if (atom.revision === proposal.atom.expectedRevision + 1
      && projectionMatches(atom, proposal.replacement)) {
      await this.invalidate?.(atom.branch);
      return revisionResult(
        proposal,
        'noop',
        `Memory atom ${atom.id} already contains the requested projection revision.`,
        [],
        atom.revision,
      );
    }
    if (atom.revision !== proposal.atom.expectedRevision) {
      return revisionResult(
        proposal,
        'rejected',
        `Memory atom ${atom.id} revision changed before projection refinement.`,
        [],
        atom.revision,
      );
    }

    const boundary = validateAtomRevisionBoundary(atom, proposal.replacement);
    if (boundary) return revisionResult(proposal, 'rejected', boundary, [], atom.revision);
    if (projectionMatches(atom, proposal.replacement)) {
      return revisionResult(
        proposal,
        'noop',
        `Memory atom ${atom.id} already contains the requested projection.`,
        [],
        atom.revision,
      );
    }

    try {
      const result = await this.management.manageAtom({
        action: 'revise',
        atomId: atom.id,
        expectedRevision: atom.revision,
        patch: proposal.replacement,
        reason: revisionReason(proposal),
        evidenceRefs: proposal.evidenceRefs,
      });
      await this.invalidate?.(atom.branch);
      const updated = result.atoms.find((candidate) => candidate.id === atom.id);
      return revisionResult(
        proposal,
        'committed',
        `Refined the same-claim projection for ${atom.id}.`,
        [result],
        updated?.revision ?? atom.revision + 1,
      );
    } catch (error) {
      return revisionResult(
        proposal,
        revisionFailureStatus(error),
        `Atom projection refinement failed: ${revisionErrorMessage(error)}`,
        [],
        atom.revision,
      );
    }
  }
}
