import type { Message } from '@littlesheep/types';
import {
  continuityMessageText,
  continuityOverlap,
  continuityRequestedValueLabels,
  continuityRequestedValueTargets,
  continuityValueTargetMatched,
  type ContinuityOverlap,
  type ContinuityValueSource,
  type ContinuityValueTarget,
  type MemoryAtomText,
} from './response-continuity-text.js';

export interface RequestedValueSourceEvidence {
  targetCount: number;
  overlapCount: number;
  allMatched: boolean;
}

export interface RequestedValueEvidence {
  requestedLabelCount: number;
  targets: ContinuityValueTarget[];
  overlapCount: number;
  matchedCount: number;
  allMatched: boolean;
  bySource: Record<ContinuityValueSource, RequestedValueSourceEvidence>;
}

interface RequestedValueEvidenceInput {
  enabled: boolean;
  request: string;
  reply?: string;
  replyTerms: Set<string>;
  recentHistory: readonly Message[];
  sessionSummaryIncluded: boolean;
  sessionSummaryText?: string;
  atomTexts: readonly MemoryAtomText[];
  unscopedInitialText: string;
}

/** Resolve and verify every concrete prior value explicitly requested by the user. */
export function collectRequestedValueEvidence(
  input: RequestedValueEvidenceInput,
): RequestedValueEvidence {
  const requestedLabels = input.enabled
    ? continuityRequestedValueLabels(input.request)
    : [];
  const targets = input.enabled
    ? continuityRequestedValueTargets(input.request, [
        {
          source: 'recent_history',
          texts: input.recentHistory.map(continuityMessageText),
        },
        {
          source: 'session_summary',
          texts: input.sessionSummaryIncluded && input.sessionSummaryText
            ? [input.sessionSummaryText]
            : [],
        },
        {
          source: 'active_memory_atom',
          texts: [
            ...input.atomTexts.map((atom) => atom.text),
            ...(input.unscopedInitialText ? [input.unscopedInitialText] : []),
          ],
        },
      ])
    : [];
  const matches = targets.map((target) => {
    const rawOverlap = continuityOverlap(input.replyTerms, target.terms);
    const matched = continuityValueTargetMatched(input.reply, target, rawOverlap);
    const overlap = matched && rawOverlap.count === 0
      ? {
          count: 1,
          ratio: 1,
          terms: [`${target.label}:${target.value}`],
        }
      : rawOverlap;
    return {
      target,
      overlap,
      matched,
    };
  });
  const matchedCount = matches.filter((match) => match.matched).length;

  return {
    requestedLabelCount: requestedLabels.length,
    targets,
    overlapCount: matches.reduce((total, match) => total + match.overlap.count, 0),
    matchedCount,
    allMatched: requestedLabels.length > 0
      && targets.length === requestedLabels.length
      && matchedCount === requestedLabels.length,
    bySource: {
      recent_history: sourceEvidence(matches, 'recent_history', requestedLabels.length),
      session_summary: sourceEvidence(matches, 'session_summary', requestedLabels.length),
      active_memory_atom: sourceEvidence(matches, 'active_memory_atom', requestedLabels.length),
    },
  };
}

function sourceEvidence(
  matches: ReadonlyArray<{
    target: ContinuityValueTarget;
    overlap: ContinuityOverlap;
    matched: boolean;
  }>,
  source: ContinuityValueSource,
  requestedLabelCount: number,
): RequestedValueSourceEvidence {
  const selected = matches.filter((match) => match.target.source === source);
  return {
    targetCount: selected.length,
    overlapCount: selected.reduce((total, match) => total + match.overlap.count, 0),
    allMatched: requestedLabelCount > 0
      && selected.length === requestedLabelCount
      && selected.every((match) => match.matched),
  };
}
