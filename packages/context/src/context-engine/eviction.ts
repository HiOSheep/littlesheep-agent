import type { ChatRequest } from '@littlesheep/llm';
import { requestFromCandidates } from './assembly.js';
import type { ContextMessageCandidate } from './contracts.js';

export interface ContextEvictionState {
  request: ChatRequest;
  measurement: number;
}

export interface ContextOmissionUnit {
  id: string;
  priority: number;
  order: number;
}

export function optionalOmissionUnits(candidates: ContextMessageCandidate[]): ContextOmissionUnit[] {
  return candidates.flatMap((candidate) => candidate.segments
    ? candidate.segments
        .filter((segment) => !segment.required)
        .map((segment) => ({ id: segment.id, priority: segment.priority, order: segment.order }))
    : candidate.required
      ? []
      : [{ id: candidate.id, priority: candidate.priority, order: candidate.order }])
    .sort((left, right) => left.priority - right.priority || left.order - right.order || left.id.localeCompare(right.id));
}

export function evictOptionalContext(
  state: ContextEvictionState,
  base: ChatRequest,
  candidates: ContextMessageCandidate[],
  omitted: Set<string>,
  units: ContextOmissionUnit[],
  availablePromptTokens: number,
  measure: (request: ChatRequest) => number,
): void {
  for (const unit of units) {
    if (omitted.has(unit.id)) continue;
    omitted.add(unit.id);
    state.request = requestFromCandidates(base, candidates, omitted);
    state.measurement = measure(state.request);
    if (state.measurement <= availablePromptTokens) break;
  }
}
