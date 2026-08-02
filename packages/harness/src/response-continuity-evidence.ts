// Extracts bounded, causally observed evidence used by the reply continuity verdict.

import type {
  CompactionSummary,
  ContextSnapshot,
  Message,
  ModelRequestSnapshot,
  ReplyProvenance,
  RuntimeMemoryContextWorkingSet,
  RuntimeMemoryKnownState,
  TaskBook,
  ToolResult,
} from '@littlesheep/types';
import { isExplicitContinuationRequest } from './continuation-intent.js';
import {
  resolveResponseContinuityExposure,
  type ResponseContinuityExposure,
} from './response-continuity-exposure.js';
import {
  continuityMessageText,
  continuityOverlap,
  continuityTerms,
  parseMemoryAtomSections,
  strongContinuityAnchor,
  stripMemoryAtomSections,
  withoutContinuityTerms,
} from './response-continuity-text.js';

const MAX_HISTORY_MESSAGES = 8;
const MAX_CONTINUATION_HISTORY_MESSAGES = 2;
const MAX_REFERENCED_ATOMS = 32;
const MAX_MATCHED_ATOMS = 16;

export interface ResponseContinuityInput {
  reply?: string;
  inbound?: Message;
  history?: Message[];
  initialMemoryContext?: string;
  sessionSummary?: CompactionSummary;
  memoryKnownState?: RuntimeMemoryKnownState;
  memoryContextWorkingSet?: RuntimeMemoryContextWorkingSet;
  taskBook?: TaskBook;
  toolResults?: ToolResult[];
  modelRequests?: ModelRequestSnapshot[];
  contextSnapshots?: ContextSnapshot[];
  replyProvenance?: ReplyProvenance;
  evaluatedAt?: string;
}

export interface ResponseContinuityEvidence {
  exposure: ResponseContinuityExposure;
  evaluatedAt: string;
  explicitContinuationRequest: boolean;
  initialContext: boolean;
  sessionSummary: boolean;
  recentHistoryMessages: number;
  activeMemoryAtoms: number;
  adoptedMemoryReferences: number;
  excludedOrConflictedReferences: number;
  hasTextEvidence: boolean;
  hasMemoryMetadata: boolean;
  replyTermCount: number;
  inboundTermCount: number;
  requestOverlapCount: number;
  taskOverlapCount: number;
  memoryTermCount: number;
  memoryAnchorCount: number;
  summaryAnchorCount: number;
  historyAnchorCount: number;
  independentContinuityAnchorCount: number;
  memoryTermsAvailable: boolean;
  summaryTermsAvailable: boolean;
  historyTermsAvailable: boolean;
  strongMemoryAnchor: boolean;
  strongSummaryAnchor: boolean;
  strongHistoryAnchor: boolean;
  hasContinuationTargetEvidence: boolean;
  continuationTargetOverlapCount: number;
  continuationTargetMatched: boolean;
  matchedAtomIds: string[];
  referencedAtomIds: string[];
}

export function collectResponseContinuityEvidence(
  input: ResponseContinuityInput,
): ResponseContinuityEvidence {
  const exposure = resolveResponseContinuityExposure({
    replyProvenance: input.replyProvenance,
    modelRequests: input.modelRequests,
    contextSnapshots: input.contextSnapshots,
    sessionSummaryId: input.sessionSummary?.id,
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
    continuityTerms(exposure.sessionSummaryIncluded ? input.sessionSummary?.summary : undefined),
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
  const effectiveHistoryOverlap = explicitContinuationRequest
    ? continuationHistoryOverlap
    : historyOverlap;
  const memoryTermCount = atomTexts.reduce(
    (total, atom) => total + continuityTerms(atom.text).size,
    unscopedMemoryTerms.size,
  );
  const memoryAnchorCount = atomMemoryAnchorCount + unscopedMemoryOverlap.count;
  const strongMemoryAnchor = matchedAtomIds.length > 0
    || strongContinuityAnchor(unscopedMemoryOverlap);
  const strongSummaryAnchor = strongContinuityAnchor(summaryOverlap);
  const strongHistoryAnchor = strongContinuityAnchor(effectiveHistoryOverlap);
  const hasContinuationHistoryTarget = continuationHistoryTerms.size > 0;
  const hasContinuationSummaryTarget = !hasContinuationHistoryTarget && summaryTerms.size > 0;
  const hasContinuationMemoryTarget = !hasContinuationHistoryTarget
    && !hasContinuationSummaryTarget
    && memoryTermCount > 0;
  const rawMemoryOverlapCount = atomMatches.reduce(
    (total, match) => total + match.overlap.count,
    unscopedMemoryOverlap.count,
  );
  const continuationTargetOverlapCount = hasContinuationHistoryTarget
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
    sessionSummary: Boolean(exposure.sessionSummaryIncluded && input.sessionSummary?.summary.trim()),
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
    summaryAnchorCount: summaryOverlap.count,
    historyAnchorCount: effectiveHistoryOverlap.count,
    independentContinuityAnchorCount: memoryAnchorCount
      + summaryOverlap.count
      + effectiveHistoryOverlap.count,
    memoryTermsAvailable: eligibleAtomIds.size > 0 || unscopedMemoryTerms.size > 0,
    summaryTermsAvailable: summaryTerms.size > 0,
    historyTermsAvailable: explicitContinuationRequest
      ? continuationHistoryTerms.size > 0
      : historyTerms.size > 0,
    strongMemoryAnchor,
    strongSummaryAnchor,
    strongHistoryAnchor,
    hasContinuationTargetEvidence: hasContinuationHistoryTarget
      || hasContinuationSummaryTarget
      || hasContinuationMemoryTarget,
    continuationTargetOverlapCount,
    continuationTargetMatched: hasContinuationHistoryTarget
      ? strongContinuityAnchor(continuationHistoryOverlap)
      : hasContinuationSummaryTarget
        ? strongSummaryAnchor
        : hasContinuationMemoryTarget
          ? strongMemoryAnchor
          : false,
    matchedAtomIds,
    referencedAtomIds: references
      .map((reference) => reference.atomId)
      .slice(0, MAX_REFERENCED_ATOMS),
  };
}
