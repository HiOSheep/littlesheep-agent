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
  /**
   * The unit may not be dropped at all: it belongs to the part of the request
   * the caller has already sent.
   */
  protected?: boolean;
}

export function optionalOmissionUnits(
  candidates: ContextMessageCandidate[],
  protectedIds: ReadonlySet<string> = new Set(),
): ContextOmissionUnit[] {
  const groups = new Map<string, ContextOmissionUnit>();
  const add = (
    id: string,
    group: string,
    priority: number,
    order: number,
    candidateProtected = false,
  ) => {
    const isProtected = candidateProtected || protectedIds.has(id);
    const current = groups.get(group);
    if (current) {
      current.ids.push(id);
      current.priority = Math.min(current.priority, priority);
      current.order = Math.min(current.order, order);
      current.protected = current.protected === true || isProtected;
      return;
    }
    groups.set(group, { id, ids: [id], priority, order, ...(isProtected ? { protected: true } : {}) });
  };

  for (const candidate of candidates) {
    // A pinned candidate may only be dropped by the call contract (which decides
    // what the call may read), never by budget eviction: its bytes are the prefix
    // the next request has to extend.
    if (candidate.pinned === true) continue;
    if (candidate.segments) {
      // Protecting a message protects every section it was delivered with: a
      // segment dropped here rewrites the message the caller already sent.
      const candidateProtected = protectedIds.has(candidate.id);
      for (const segment of candidate.segments) {
        if (!segment.required) add(
          segment.id,
          segment.evictionGroup ?? segment.id,
          segment.priority,
          segment.order,
          candidateProtected,
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
    // A protected unit stays in the request, so dropping it is not an option to
    // consider at all: it is left out of the candidate list rather than being
    // skipped later, which keeps the eviction loop's accounting honest.
    .filter((unit) => unit.protected !== true)
    .sort((left, right) => left.priority - right.priority || left.order - right.order || left.id.localeCompare(right.id));
}

/**
 * The unit ids one assembled request actually delivered.
 *
 * Append-only protection is derived from this set instead of the candidate list:
 * a unit the previous request had already trimmed is not resurrected, and a unit
 * it delivered cannot be dropped afterwards, because dropping it would renumber
 * every message after it and invalidate the Provider's cached prefix.
 */
export function deliveredUnitIds(
  candidates: readonly ContextMessageCandidate[],
  omitted: ReadonlySet<string>,
): Set<string> {
  const delivered = new Set<string>();
  for (const candidate of candidates) {
    if (omitted.has(candidate.id)) continue;
    const segments = candidate.segments;
    if (!segments) {
      delivered.add(candidate.id);
      continue;
    }
    let intact = true;
    for (const segment of segments) {
      if (omitted.has(segment.id)) {
        intact = false;
        continue;
      }
      delivered.add(segment.id);
    }
    // A message delivered whole is protected as a whole, so later unit-list
    // changes cannot drop a section the caller already received with it.
    if (intact) delivered.add(candidate.id);
  }
  return delivered;
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
