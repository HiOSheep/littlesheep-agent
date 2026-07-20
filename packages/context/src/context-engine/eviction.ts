import type { ChatRequest } from '@littlesheep/llm';
import { requestFromCandidates } from './assembly.js';
import type { ContextMessageCandidate } from './contracts.js';

export interface ContextEvictionState {
  request: ChatRequest;
  measurement: number;
}

export interface ContextOmissionUnit {
  id: string;
  ids: string[];
  priority: number;
  order: number;
}

export function optionalOmissionUnits(candidates: ContextMessageCandidate[]): ContextOmissionUnit[] {
  const groups = new Map<string, ContextOmissionUnit>();
  const add = (id: string, group: string, priority: number, order: number) => {
    const current = groups.get(group);
    if (current) {
      current.ids.push(id);
      current.priority = Math.min(current.priority, priority);
      current.order = Math.min(current.order, order);
      return;
    }
    groups.set(group, { id, ids: [id], priority, order });
  };

  for (const candidate of candidates) {
    if (candidate.segments) {
      for (const segment of candidate.segments) {
        if (!segment.required) add(
          segment.id,
          segment.evictionGroup ?? segment.id,
          segment.priority,
          segment.order,
        );
      }
      continue;
    }
    if (!candidate.required) add(
      candidate.id,
      candidate.evictionGroup ?? candidate.id,
      candidate.priority,
      candidate.order,
    );
  }

  return [...groups.values()]
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
    for (const id of unit.ids) omitted.add(id);
    state.request = requestFromCandidates(base, candidates, omitted);
    state.measurement = measure(state.request);
    if (state.measurement <= availablePromptTokens) break;
  }
}
