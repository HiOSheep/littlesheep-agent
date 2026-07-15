import type { ChatRequest } from '@littlesheep/llm';
import type { ContextMessageCandidate } from './contracts.js';

export function requestFromCandidates(
  base: ChatRequest,
  candidates: ContextMessageCandidate[],
  omitted: Set<string>,
): ChatRequest {
  return {
    ...base,
    messages: candidates
      .filter((candidate) => !omitted.has(candidate.id))
      .map((candidate) => candidate.segments
        ? {
            ...candidate.message,
            content: candidate.segments
              .filter((segment) => !omitted.has(segment.id))
              .map((segment) => segment.text)
              .join(''),
          }
        : candidate.message),
  };
}
