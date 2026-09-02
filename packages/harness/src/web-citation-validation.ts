import type { WebEvidenceProjection } from '@littlesheep/types';

const CITATION_TOKEN = /\[citation:(web-[A-Za-z0-9-]{3,200})\]/gu;
const WEB_ID_LIKE = /\bweb-[A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,}\b/gu;
export const MAX_WEB_CITATION_REPAIRS = 2;

export interface WebCitationValidation {
  readonly ok: boolean;
  readonly citedIds: readonly string[];
  readonly unknownIds: readonly string[];
  readonly reason?: string;
}

export function validateWebCitations(
  reply: string,
  evidence: WebEvidenceProjection | undefined,
): WebCitationValidation {
  const allowed = new Set(evidence?.citationIds ?? []);
  const explicit = [...reply.matchAll(CITATION_TOKEN)].map((match) => match[1]!);
  const idLike = [...reply.matchAll(WEB_ID_LIKE)].map((match) => match[0]!);
  const citedIds = [...new Set([...explicit, ...idLike])];
  const unknownIds = citedIds.filter((id) => !allowed.has(id));
  if (unknownIds.length > 0) {
    return {
      ok: false,
      citedIds,
      unknownIds,
      reason: `reply contains unknown web citation ids: ${unknownIds.join(', ')}`,
    };
  }
  if (allowed.size > 0 && explicit.length === 0) {
    return {
      ok: false,
      citedIds,
      unknownIds: [],
      reason: 'web-backed reply must include at least one [citation:<runtime-id>] token',
    };
  }
  return { ok: true, citedIds, unknownIds: [] };
}

export function webCitationRepairContract(evidence: WebEvidenceProjection): string {
  const state = [
    evidence.partial ? 'partial' : undefined,
    evidence.truncated ? 'truncated' : undefined,
    evidence.blocked ? 'blocked' : undefined,
    evidence.stale ? 'stale' : undefined,
  ].filter(Boolean).join(', ') || 'complete';
  return `Runtime citation contract:
- The only valid web citation ids are: ${evidence.citationIds.join(', ') || '(none)'}.
- Cite a source using the exact token [citation:<runtime-id>].
- Never invent, alter or reuse another run's citation id.
- Retrieval state is ${state}; preserve partial, truncated, blocked or stale uncertainty in the answer.
- Return only the corrected user-facing text.`;
}
