// Runtime-owned correction boundary. The model may point to two existing
// projections and an explicit relation; Runtime decides whether the newer
// Atom may supersede the older one without rewriting either source history.

import type { MemoryRepositoryManagementFacade } from './memory-repository/management.js';
import type { MemoryBranchKind } from './types.js';
import type {
  MemoryAtomCorrectionProposal,
  MemoryAtomCorrectionResult,
  MemoryAtomCorrectionServiceLike,
} from './memory-correction-contracts.js';
import {
  MAX_CORRECTION_PROPOSALS,
  correctionErrorMessage,
  correctionFailureStatus,
  correctionReason,
  correctionResult,
  explicitCorrectionRelation,
  validateAtomCorrectionBoundary,
  validateCorrectionProposal,
} from './memory-correction-validation.js';

export type {
  MemoryAtomCorrectionBasis,
  MemoryAtomCorrectionProposal,
  MemoryAtomCorrectionResult,
  MemoryAtomCorrectionServiceLike,
  MemoryAtomCorrectionStatus,
} from './memory-correction-contracts.js';
export { MAX_CORRECTION_PROPOSALS } from './memory-correction-validation.js';

export interface MemoryAtomCorrectionServiceOptions {
  management: MemoryRepositoryManagementFacade;
  invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;
}

export class MemoryAtomCorrectionService implements MemoryAtomCorrectionServiceLike {
  private readonly management: MemoryRepositoryManagementFacade;
  private readonly invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;

  constructor(options: MemoryAtomCorrectionServiceOptions) {
    this.management = options.management;
    this.invalidate = options.invalidate;
  }

  async resolve(proposals: readonly MemoryAtomCorrectionProposal[]): Promise<MemoryAtomCorrectionResult[]> {
    const bounded = proposals.slice(0, MAX_CORRECTION_PROPOSALS);
    const status = await this.management.status();
    if (status.backendKind !== 'v3') {
      return bounded.map((proposal) => correctionResult(
        proposal,
        'deferred',
        'Memory v3 Atom correction is unavailable.',
      ));
    }
    const results: MemoryAtomCorrectionResult[] = [];
    for (const proposal of bounded) results.push(await this.resolveOne(proposal));
    return results;
  }

  private async resolveOne(proposal: MemoryAtomCorrectionProposal): Promise<MemoryAtomCorrectionResult> {
    const invalid = validateCorrectionProposal(proposal);
    if (invalid) return correctionResult(proposal, 'rejected', invalid);

    const [oldInspection, replacementInspection] = await Promise.all([
      this.management.inspectNode(proposal.superseded.atomId, 'D3'),
      this.management.inspectNode(proposal.replacement.atomId, 'D3'),
    ]);
    const oldAtom = oldInspection?.atom;
    const replacement = replacementInspection?.atom;
    if (!oldAtom) {
      return correctionResult(proposal, 'rejected', `Memory atom was not found: ${proposal.superseded.atomId}.`);
    }
    if (!replacement) {
      return correctionResult(proposal, 'rejected', `Replacement memory atom was not found: ${proposal.replacement.atomId}.`);
    }
    if (oldAtom.revision === proposal.superseded.expectedRevision + 1
      && oldAtom.epistemicStatus === 'superseded'
      && oldAtom.resolutionStatus === 'superseded'
      && oldAtom.supersession?.byAtomId === replacement.id
      && oldAtom.supersession.relationId === proposal.relationId) {
      await this.invalidate?.(oldAtom.branch);
      return correctionResult(
        proposal,
        'noop',
        `Memory atom ${oldAtom.id} was already superseded by ${replacement.id}.`,
        [],
        oldAtom.revision,
      );
    }
    if (oldAtom.revision !== proposal.superseded.expectedRevision) {
      return correctionResult(
        proposal,
        'rejected',
        `Memory atom ${oldAtom.id} revision changed before correction.`,
        [],
        oldAtom.revision,
      );
    }
    if (replacement.revision !== proposal.replacement.expectedRevision) {
      return correctionResult(
        proposal,
        'rejected',
        `Replacement memory atom ${replacement.id} revision changed before correction.`,
        [],
        oldAtom.revision,
      );
    }

    const boundary = validateAtomCorrectionBoundary(oldAtom, replacement);
    if (boundary) return correctionResult(proposal, 'rejected', boundary, [], oldAtom.revision);
    const relation = explicitCorrectionRelation(
      proposal,
      oldAtom,
      replacement,
      oldInspection?.neighborhood,
      replacementInspection?.neighborhood,
    );
    if (!relation) {
      return correctionResult(
        proposal,
        'rejected',
        `No active, resolved and evidenced ${proposal.basis} relation proves that ${replacement.id} replaces ${oldAtom.id}.`,
        [],
        oldAtom.revision,
      );
    }

    try {
      const result = await this.management.manageAtom({
        action: 'supersede',
        atomId: oldAtom.id,
        expectedRevision: oldAtom.revision,
        replacementAtomId: replacement.id,
        replacementExpectedRevision: replacement.revision,
        relationId: relation.id,
        reason: correctionReason(proposal),
        evidenceRefs: unique([
          ...proposal.evidenceRefs,
          ...relation.sourceRefs,
          ...relation.evidenceRefs,
        ]).slice(0, 256),
      });
      await this.invalidate?.(oldAtom.branch);
      const updated = result.atoms.find((atom) => atom.id === oldAtom.id);
      return correctionResult(
        proposal,
        'committed',
        `Superseded ${oldAtom.id} with the evidenced replacement ${replacement.id}.`,
        [result],
        updated?.revision ?? oldAtom.revision + 1,
      );
    } catch (error) {
      return correctionResult(
        proposal,
        correctionFailureStatus(error),
        `Atom correction failed: ${correctionErrorMessage(error)}`,
        [],
        oldAtom.revision,
      );
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
