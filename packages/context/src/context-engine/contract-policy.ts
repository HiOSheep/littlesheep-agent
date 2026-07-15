import type { ContextItemKind, LlmCallContract, StageName } from '@littlesheep/types';
import { inferCandidates, normalizeCandidates } from './candidates.js';
import {
  ContextContractViolationError,
  type ContextMessageCandidate,
  type PrepareContextRequestInput,
} from './contracts.js';

/** Resolve explicit or inferred candidates, then apply the call contract once. */
export function prepareContextCandidates(input: PrepareContextRequestInput): ContextMessageCandidate[] {
  const candidates = normalizeCandidates(input.candidates ?? inferCandidates(input.request.messages));
  return enforceContextContract(input.stage, input.callContract, candidates);
}

/** Apply a resolved call contract before budgeting or request assembly. */
export function enforceContextContract(
  stage: StageName,
  contract: LlmCallContract | undefined,
  candidates: ContextMessageCandidate[],
): ContextMessageCandidate[] {
  if (!contract) return candidates;
  if (contract.modelCall === 'forbidden') {
    throw new ContextContractViolationError(contract, 'forbidden_model_call', {
      message: 'this purpose forbids a model request.',
    });
  }
  if (contract.stage !== stage) {
    throw new ContextContractViolationError(contract, 'stage_mismatch', {
      message: `contract stage ${contract.stage} does not match request stage ${stage}.`,
    });
  }

  const allowed = new Set<ContextItemKind>(contract.inputs.allowedContextKinds);
  const filtered = candidates.flatMap((candidate) => {
    if (!candidate.segments) {
      if (allowed.has(candidate.kind)) return [candidate];
      if (candidate.required) rejectRequired(contract, candidate.kind, candidate.id);
      return [];
    }

    const segments = candidate.segments.filter((segment) => {
      if (allowed.has(segment.kind)) return true;
      if (segment.required) rejectRequired(contract, segment.kind, segment.id);
      return false;
    });
    if (segments.length === 0) return [];
    return [{
      ...candidate,
      message: {
        ...candidate.message,
        content: segments.map((segment) => segment.text).join(''),
      },
      segments,
    }];
  });

  const presentKinds = new Set<ContextItemKind>();
  for (const candidate of filtered) {
    if (candidate.segments) {
      for (const segment of candidate.segments) presentKinds.add(segment.kind);
    } else {
      presentKinds.add(candidate.kind);
    }
  }
  for (const kind of contract.inputs.requiredContextKinds) {
    if (presentKinds.has(kind)) continue;
    throw new ContextContractViolationError(contract, 'required_context_missing', {
      contextKind: kind,
      message: `required Context kind ${kind} is absent after contract filtering.`,
    });
  }
  return filtered;
}

function rejectRequired(
  contract: LlmCallContract,
  kind: ContextItemKind,
  candidateId: string,
): never {
  throw new ContextContractViolationError(contract, 'required_context_forbidden', {
    contextKind: kind,
    candidateId,
    message: `required source ${candidateId} has forbidden kind ${kind}.`,
  });
}
