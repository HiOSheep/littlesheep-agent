import type { RuntimeKnownStateMemoryReference } from '@littlesheep/types';
import type { MemoryAtomSubtreeMoveProposal } from '@littlesheep/memory-tree';
import { isCurrentAdopted } from './atom-proposal-support.js';

export interface RawSubtreeMoveProposal {
  action?: unknown;
  basis?: unknown;
  root?: unknown;
  parent?: unknown;
  relationId?: unknown;
  reason?: unknown;
}

export function validateEvolveSubtreeMove(input: {
  raw?: RawSubtreeMoveProposal;
  root?: MemoryAtomSubtreeMoveProposal['root'];
  parent?: MemoryAtomSubtreeMoveProposal['parent'];
  relationId?: string;
  reason?: string;
  rootKnown?: RuntimeKnownStateMemoryReference;
  parentKnown?: RuntimeKnownStateMemoryReference;
  evidence: { refs: string[]; verified: boolean };
  contractAllowsMove: boolean;
}): string | undefined {
  if (!input.raw || input.raw.action !== 'move-subtree'
    || input.raw.basis !== 'explicit-parent-relation') {
    return 'Only explicit-parent-relation subtree move proposals are accepted.';
  }
  if (!input.contractAllowsMove) return 'The evolve call contract does not allow subtree move proposals.';
  if (!input.evidence.verified || input.evidence.refs.length === 0) {
    return 'A subtree move proposal requires a passing verification record and runtime evidence.';
  }
  if (!input.root || !input.parent || !input.relationId || !input.reason || input.reason.length < 12) {
    return 'A subtree move proposal needs one root, one parent, one relation id and a concrete reason.';
  }
  if (input.root.atomId === input.parent.atomId) return 'A memory subtree root cannot become its own parent.';
  if (!input.rootKnown || !isCurrentCompleteAdopted(input.rootKnown, input.root.expectedRevision)) {
    return `Subtree root ${input.root.atomId} is not an adopted, current and complete D3 KnownState reference.`;
  }
  if (!input.parentKnown || !isCurrentCompleteAdopted(input.parentKnown, input.parent.expectedRevision)) {
    return `Parent Atom ${input.parent.atomId} is not an adopted, current and complete D3 KnownState reference.`;
  }
  if (input.rootKnown.envelope.branch !== input.parentKnown.envelope.branch
    || input.rootKnown.envelope.scope !== input.parentKnown.envelope.scope
    || (input.rootKnown.envelope.scopeKey ?? '') !== (input.parentKnown.envelope.scopeKey ?? '')) {
    return `Parent Atom ${input.parent.atomId} crosses the subtree branch or scope boundary.`;
  }
  return undefined;
}

function isCurrentCompleteAdopted(
  reference: RuntimeKnownStateMemoryReference,
  revision: number,
): boolean {
  return isCurrentAdopted(reference, revision)
    && reference.envelope.disclosureLevel === 'D3'
    && !reference.envelope.truncated
    && reference.envelope.atomId === reference.atomId
    && reference.envelope.atomRevision === revision;
}
