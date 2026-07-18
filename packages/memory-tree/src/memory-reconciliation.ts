// Runtime-owned validation and commit boundary for model-proposed Atom merges.
// The model may identify semantic duplicates, but it never receives storage
// mutation authority. This service keeps the proposal bounded, versioned and
// retryable while preserving the existing atomic management operations.

import type { MemoryAtom } from './v3/contracts.js';
import type {
  MemoryAtomManagementResult,
  MemoryRepositoryManagementFacade,
} from './memory-repository/management.js';
import type { MemoryBranchKind } from './types.js';
import type {
  MemoryAtomReconciliationProposal,
  MemoryAtomReconciliationResult,
  MemoryAtomReconciliationServiceLike,
  MemoryAtomRevisionReference,
} from './memory-reconciliation-contracts.js';
import {
  MAX_RECONCILIATION_PROPOSALS,
  classifyReconciliationFailure,
  errorMessage,
  hasBlockingSemanticRelation,
  hasDeterministicSemanticAnchor,
  reconciliationReason,
  rejectedReconciliation,
  validateAtomMergeBoundary,
  validateReconciliationProposal,
} from './memory-reconciliation-validation.js';

export type {
  MemoryAtomMergeProposal,
  MemoryAtomReconciliationProposal,
  MemoryAtomReconciliationResult,
  MemoryAtomReconciliationServiceLike,
  MemoryAtomReconciliationStatus,
  MemoryAtomRevisionReference,
} from './memory-reconciliation-contracts.js';

export interface MemoryAtomReconciliationServiceOptions {
  management: MemoryRepositoryManagementFacade;
  invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;
}

export class MemoryAtomReconciliationService implements MemoryAtomReconciliationServiceLike {
  private readonly management: MemoryRepositoryManagementFacade;
  private readonly invalidate?: (branch: MemoryBranchKind) => void | Promise<void>;

  constructor(options: MemoryAtomReconciliationServiceOptions) {
    this.management = options.management;
    this.invalidate = options.invalidate;
  }

  async reconcile(
    proposals: readonly MemoryAtomReconciliationProposal[],
  ): Promise<MemoryAtomReconciliationResult[]> {
    const bounded = proposals.slice(0, MAX_RECONCILIATION_PROPOSALS);
    const status = await this.management.status();
    if (status.backendKind !== 'v3') {
      return bounded.map((proposal) => deferred(proposal, 'Memory v3 reconciliation is unavailable.'));
    }
    const results: MemoryAtomReconciliationResult[] = [];
    for (const proposal of bounded) {
      results.push(await this.reconcileOne(proposal));
    }
    return results;
  }

  private async reconcileOne(
    proposal: MemoryAtomReconciliationProposal,
  ): Promise<MemoryAtomReconciliationResult> {
    const sourceIds = proposal.sources.map((source) => source.atomId);
    const base = {
      proposalId: proposal.id,
      targetAtomId: proposal.target.atomId,
      sourceAtomIds: [...sourceIds],
    };
    const invalid = validateReconciliationProposal(proposal);
    if (invalid) return rejectedReconciliation(base, invalid);

    const inspections = await Promise.all([
      this.management.inspectNode(proposal.target.atomId, 'D3'),
      ...proposal.sources.map((source) => this.management.inspectNode(source.atomId, 'D3')),
    ]);
    const targetInspection = inspections[0];
    const target = targetInspection?.atom;
    if (!target) return rejectedReconciliation(base, `Target memory atom was not found: ${proposal.target.atomId}.`);
    const sourceInspections = inspections.slice(1);
    const sourceAtoms = sourceInspections.map((inspection) => inspection?.atom);
    if (sourceAtoms.some((atom) => !atom)) {
      const missing = proposal.sources.find((_, index) => !sourceAtoms[index]);
      return rejectedReconciliation(base, `Source memory atom was not found: ${missing?.atomId ?? 'unknown'}.`);
    }
    const atoms = sourceAtoms as MemoryAtom[];
    const pending: Array<{ ref: MemoryAtomRevisionReference; atom: MemoryAtom }> = [];
    const committedSourceAtomIds: string[] = [];
    for (const [index, atom] of atoms.entries()) {
      const ref = proposal.sources[index]!;
      if (atom.status === 'tombstone'
        && atom.merge?.intoAtomId === target.id
        && atom.revision === ref.expectedRevision + 1) {
        committedSourceAtomIds.push(atom.id);
        continue;
      }
      if (atom.status !== 'active') {
        return rejectedReconciliation(base, `Source memory atom ${atom.id} is not active.`);
      }
      if (atom.revision !== ref.expectedRevision) {
        return rejectedReconciliation(base, `Source memory atom ${atom.id} revision changed before reconciliation.`);
      }
      pending.push({ ref, atom });
    }
    if (target.status !== 'active') return rejectedReconciliation(base, 'The merge target must remain active.');
    if (target.revision !== proposal.target.expectedRevision + committedSourceAtomIds.length) {
      return rejectedReconciliation(base, `Target memory atom ${target.id} revision changed before reconciliation.`);
    }

    const targetInspectionForChecks = targetInspection;
    for (const [index, source] of atoms.entries()) {
      const sourceInspection = sourceInspections[index]!;
      const boundaryError = validateAtomMergeBoundary(target, source);
      if (boundaryError) return rejectedReconciliation(base, boundaryError);
      if (!hasDeterministicSemanticAnchor(target, source)) {
        return rejectedReconciliation(base, `No deterministic duplicate anchor was found between ${target.id} and ${source.id}.`);
      }
      if (hasBlockingSemanticRelation(target, source, targetInspectionForChecks?.neighborhood, sourceInspection?.neighborhood)) {
        return rejectedReconciliation(base, `A conflict or replacement relation prevents merging ${source.id} into ${target.id}.`);
      }
    }
    if (pending.length === 0) {
      return {
        ...base,
        status: 'noop',
        committedSourceAtomIds,
        remainingSourceAtomIds: [],
        reason: 'All source atoms were already merged by an earlier attempt.',
        managementResults: [],
      };
    }

    const managementResults: MemoryAtomManagementResult[] = [];
    let targetRevision = target.revision;
    const newlyCommitted: string[] = [];
    for (const { ref, atom } of pending) {
      try {
        const result = await this.management.manageAtom({
          action: 'merge',
          atomId: atom.id,
          expectedRevision: ref.expectedRevision,
          targetAtomId: target.id,
          targetExpectedRevision: targetRevision,
          reason: reconciliationReason(proposal),
        });
        managementResults.push(result);
        newlyCommitted.push(atom.id);
        targetRevision = result.atoms.find((candidate) => candidate.id === target.id)?.revision
          ?? targetRevision + 1;
      } catch (error) {
        const committed = [...committedSourceAtomIds, ...newlyCommitted];
        if (newlyCommitted.length > 0) await this.invalidate?.(target.branch);
        return {
          ...base,
          status: committed.length > 0 ? 'partial' : classifyReconciliationFailure(error),
          committedSourceAtomIds: committed,
          remainingSourceAtomIds: pending.slice(newlyCommitted.length).map((entry) => entry.atom.id),
          reason: `Reconciliation stopped after ${committed.length} source atom(s): ${errorMessage(error)}`,
          managementResults,
        };
      }
    }
    if (newlyCommitted.length > 0) {
      await this.invalidate?.(target.branch);
    }
    return {
      ...base,
      status: 'committed',
      committedSourceAtomIds: [...committedSourceAtomIds, ...newlyCommitted],
      remainingSourceAtomIds: [],
      reason: `Merged ${newlyCommitted.length + committedSourceAtomIds.length} duplicate source atom(s) into ${target.id}.`,
      managementResults,
    };
  }
}

function deferred(
  proposal: MemoryAtomReconciliationProposal,
  reason: string,
): MemoryAtomReconciliationResult {
  return {
    proposalId: proposal.id,
    status: 'deferred',
    targetAtomId: proposal.target.atomId,
    sourceAtomIds: proposal.sources.map((source) => source.atomId),
    committedSourceAtomIds: [],
    remainingSourceAtomIds: proposal.sources.map((source) => source.atomId),
    reason,
    managementResults: [],
  };
}
