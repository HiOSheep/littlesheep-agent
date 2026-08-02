// Extracts bounded, causally observed evidence used by the reply continuity verdict.

import { isExplicitContinuationRequest } from './continuation-intent.js';
import { resolveResponseContinuityExposure } from './response-continuity-exposure.js';
import {
  continuityMessageText,
  continuityOverlap,
  continuityTerms,
  parseMemoryAtomSections,
  replyExplicitlyDisclaimsContinuity,
  strongContinuityAnchor,
  stripMemoryAtomSections,
  withoutContinuityTerms,
} from './response-continuity-text.js';
import { collectRequestedValueEvidence } from './response-continuity-targets.js';
import type {
  ResponseContinuityEvidence,
  ResponseContinuityInput,
} from './response-continuity-types.js';

const MAX_HISTORY_MESSAGES = 8;
const MAX_CONTINUATION_HISTORY_MESSAGES = 2;
const MAX_REFERENCED_ATOMS = 32;
const MAX_MATCHED_ATOMS = 16;

export function collectResponseContinuityEvidence(
  input: ResponseContinuityInput,
): ResponseContinuityEvidence {
  const sessionSummaryId = typeof input.sessionSummary?.id === 'string'
    ? input.sessionSummary.id
    : undefined;
  const sessionSummaryText = typeof input.sessionSummary?.summary === 'string'
    ? input.sessionSummary.summary
    : undefined;
  const exposure = resolveResponseContinuityExposure({
    replyProvenance: input.replyProvenance,
    modelRequests: input.modelRequests,
    contextSnapshots: input.contextSnapshots,
    sessionSummaryId,
    toolResults: input.toolResults,
  });
  const inboundText = continuityMessageText(input.inbound);
  const replyTerms = continuityTerms(input.reply);
  const inboundTerms = continuityTerms(inboundText);
  const currentRequestTerms = continuityTerms(inboundText);
  const explicitContinuationRequest = isExplicitContinuationRequest(inboundText);
  const taskTerms = continuityTerms([
    inboundText,
    input.taskBook?.goal,
    ...(input.taskBook?.successCriteria ?? []),
  ].filter(Boolean).join('\n'));
  const recentHistory = (input.history ?? [])
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .filter((message) => !exposure.strict || exposure.historyMessageIds?.has(message.id))
    .slice(-MAX_HISTORY_MESSAGES);
  const historyTerms = withoutContinuityTerms(
    continuityTerms(recentHistory.map(continuityMessageText).join('\n')),
    currentRequestTerms,
  );
  const continuationHistoryTerms = withoutContinuityTerms(
    continuityTerms(
      recentHistory
        .slice(-MAX_CONTINUATION_HISTORY_MESSAGES)
        .map(continuityMessageText)
        .join('\n'),
    ),
    currentRequestTerms,
  );
  const summaryTerms = withoutContinuityTerms(
    continuityTerms(exposure.sessionSummaryIncluded ? sessionSummaryText : undefined),
    currentRequestTerms,
  );

  const references = input.memoryKnownState?.references ?? [];
  const adoptedReferences = references.filter((reference) => reference.decision === 'adopted');
  const activeAtomIds = new Set(input.memoryContextWorkingSet?.activeAtomIds ?? []);
  const adoptedAtomIds = new Set(adoptedReferences.map((reference) => reference.atomId));
  const eligibleAtomIds = new Set([...activeAtomIds].filter((atomId) => adoptedAtomIds.has(atomId)));
  const initialMemoryContext = exposure.initialMemoryIncluded
    ? input.initialMemoryContext
    : undefined;
  const parsedAtomTexts = parseMemoryAtomSections(initialMemoryContext);
  const atomTexts = [...new Map(
    parsedAtomTexts
      .concat(exposure.memoryToolAtoms)
      .filter((atom) => eligibleAtomIds.has(atom.atomId))
      .map((atom) => [atom.atomId, atom]),
  ).values()];
  // Marked Context is authoritative per Atom. Its headings are transport
  // scaffolding and must not keep a released Atom "continuous".
  const unscopedInitialText = parsedAtomTexts.length > 0
    ? ''
    : stripMemoryAtomSections(initialMemoryContext);
  const unscopedMemoryTerms = withoutContinuityTerms(
    continuityTerms(unscopedInitialText),
    currentRequestTerms,
  );
  const requestedValues = collectRequestedValueEvidence({
    enabled: explicitContinuationRequest,
    request: inboundText,
    reply: input.reply,
    replyTerms,
    recentHistory,
    sessionSummaryIncluded: exposure.sessionSummaryIncluded,
    sessionSummaryText,
    atomTexts,
    unscopedInitialText,
  });
  const requestedValueTargets = requestedValues.targets;
  const atomMatches = atomTexts.map((atom) => ({
    atomId: atom.atomId,
    overlap: continuityOverlap(
      replyTerms,
      withoutContinuityTerms(continuityTerms(atom.text), currentRequestTerms),
    ),
  }));
  const matchedAtomIds = atomMatches
    .filter((match) => strongContinuityAnchor(match.overlap))
    .map((match) => match.atomId)
    .slice(0, MAX_MATCHED_ATOMS);
  const atomMemoryAnchorCount = atomMatches
    .filter((match) => matchedAtomIds.includes(match.atomId))
    .reduce((total, match) => total + match.overlap.count, 0);
  const unscopedMemoryOverlap = continuityOverlap(replyTerms, unscopedMemoryTerms);
  const summaryOverlap = continuityOverlap(replyTerms, summaryTerms);
  const historyOverlap = continuityOverlap(replyTerms, historyTerms);
  const continuationHistoryOverlap = continuityOverlap(replyTerms, continuationHistoryTerms);
  const requestedHistory = requestedValues.bySource.recent_history;
  const requestedSummary = requestedValues.bySource.session_summary;
  const requestedMemory = requestedValues.bySource.active_memory_atom;
  const effectiveHistoryOverlap = explicitContinuationRequest
    ? continuationHistoryOverlap
    : historyOverlap;
  const memoryTermCount = atomTexts.reduce(
    (total, atom) => total + continuityTerms(atom.text).size,
    unscopedMemoryTerms.size,
  );
  const genericMemoryAnchorCount = atomMemoryAnchorCount + unscopedMemoryOverlap.count;
  const genericStrongMemoryAnchor = matchedAtomIds.length > 0
    || strongContinuityAnchor(unscopedMemoryOverlap);
  const genericStrongSummaryAnchor = strongContinuityAnchor(summaryOverlap);
  const memoryAnchorCount = requestedValueTargets.length > 0
    ? requestedMemory.overlapCount
    : genericMemoryAnchorCount;
  const strongMemoryAnchor = requestedValueTargets.length > 0
    ? requestedMemory.allMatched
    : genericStrongMemoryAnchor;
  const strongSummaryAnchor = requestedValueTargets.length > 0
    ? requestedSummary.allMatched
    : genericStrongSummaryAnchor;
  const strongHistoryAnchor = requestedValueTargets.length > 0
    ? requestedHistory.allMatched
    : strongContinuityAnchor(effectiveHistoryOverlap);
  const hasRequestedValueTargets = requestedValueTargets.length > 0;
  const hasContinuationHistoryTarget = !hasRequestedValueTargets
    && continuationHistoryTerms.size > 0;
  const hasContinuationSummaryTarget = !hasRequestedValueTargets
    && !hasContinuationHistoryTarget
    && summaryTerms.size > 0;
  const hasContinuationMemoryTarget = !hasRequestedValueTargets
    && !hasContinuationHistoryTarget
    && !hasContinuationSummaryTarget
    && memoryTermCount > 0;
  const rawMemoryOverlapCount = atomMatches.reduce(
    (total, match) => total + match.overlap.count,
    unscopedMemoryOverlap.count,
  );
  const continuationTargetOverlapCount = hasRequestedValueTargets
    ? requestedValues.overlapCount
    : hasContinuationHistoryTarget
      ? continuationHistoryOverlap.count
    : hasContinuationSummaryTarget
      ? summaryOverlap.count
      : hasContinuationMemoryTarget
        ? rawMemoryOverlapCount
        : 0;

  return {
    exposure,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    explicitContinuationRequest,
    initialContext: Boolean(initialMemoryContext?.trim()),
    sessionSummary: Boolean(exposure.sessionSummaryIncluded && sessionSummaryText?.trim()),
    recentHistoryMessages: recentHistory.length,
    activeMemoryAtoms: eligibleAtomIds.size,
    adoptedMemoryReferences: adoptedReferences.length,
    excludedOrConflictedReferences: references.length - adoptedReferences.length,
    hasTextEvidence: atomTexts.length > 0
      || unscopedMemoryTerms.size > 0
      || summaryTerms.size > 0
      || historyTerms.size > 0,
    hasMemoryMetadata: references.length > 0,
    replyTermCount: replyTerms.size,
    inboundTermCount: inboundTerms.size,
    requestOverlapCount: continuityOverlap(replyTerms, currentRequestTerms).count,
    taskOverlapCount: continuityOverlap(replyTerms, taskTerms).count,
    memoryTermCount,
    memoryAnchorCount,
    summaryAnchorCount: requestedValueTargets.length > 0
      ? requestedSummary.overlapCount
      : summaryOverlap.count,
    historyAnchorCount: requestedValueTargets.length > 0
      ? requestedHistory.overlapCount
      : effectiveHistoryOverlap.count,
    independentContinuityAnchorCount: requestedValueTargets.length > 0
      ? requestedValues.overlapCount
      : memoryAnchorCount + summaryOverlap.count + effectiveHistoryOverlap.count,
    memoryTermsAvailable: requestedValueTargets.length > 0
      ? requestedMemory.targetCount > 0
      : eligibleAtomIds.size > 0 || unscopedMemoryTerms.size > 0,
    summaryTermsAvailable: requestedValueTargets.length > 0
      ? requestedSummary.targetCount > 0
      : summaryTerms.size > 0,
    historyTermsAvailable: explicitContinuationRequest
      ? requestedValueTargets.length > 0
        ? requestedHistory.targetCount > 0
        : continuationHistoryTerms.size > 0
      : historyTerms.size > 0,
    strongMemoryAnchor,
    strongSummaryAnchor,
    strongHistoryAnchor,
    hasContinuationTargetEvidence: hasRequestedValueTargets
      || hasContinuationHistoryTarget
      || hasContinuationSummaryTarget
      || hasContinuationMemoryTarget,
    continuationTargetOverlapCount,
    continuationTargetMatched: hasRequestedValueTargets
      ? requestedValues.allMatched
      : hasContinuationHistoryTarget
        ? strongContinuityAnchor(continuationHistoryOverlap)
      : hasContinuationSummaryTarget
        ? strongSummaryAnchor
        : hasContinuationMemoryTarget
          ? strongMemoryAnchor
          : false,
    requestedValueTargetCount: requestedValueTargets.length,
    requestedValueMatchedCount: requestedValues.matchedCount,
    replyDisclaimsContinuity: replyExplicitlyDisclaimsContinuity(input.reply),
    matchedAtomIds,
    referencedAtomIds: references
      .map((reference) => reference.atomId)
      .slice(0, MAX_REFERENCED_ATOMS),
  };
}
