import type { Message } from '@littlesheep/types';
import {
  continuityMessageText,
  continuityOverlap,
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
    const overlap = continuityOverlap(input.replyTerms, target.terms);
    return {
      target,
      overlap,
      matched: continuityValueTargetMatched(input.reply, target, overlap),
    };
  });
  const matchedCount = matches.filter((match) => match.matched).length;

  return {
    targets,
    overlapCount: matches.reduce((total, match) => total + match.overlap.count, 0),
    matchedCount,
    allMatched: targets.length > 0 && matchedCount === targets.length,
    bySource: {
      recent_history: sourceEvidence(matches, 'recent_history'),
      session_summary: sourceEvidence(matches, 'session_summary'),
      active_memory_atom: sourceEvidence(matches, 'active_memory_atom'),
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
): RequestedValueSourceEvidence {
  const selected = matches.filter((match) => match.target.source === source);
  return {
    targetCount: selected.length,
    overlapCount: selected.reduce((total, match) => total + match.overlap.count, 0),
    allMatched: selected.length > 0 && selected.every((match) => match.matched),
  };
}
