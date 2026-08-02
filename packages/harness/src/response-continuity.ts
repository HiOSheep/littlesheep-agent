// Local, bounded continuity assessment for the final user-visible reply.
// This is evidence collection, not a second model judgment. It never blocks
// the run, changes factual confidence, or triggers another Provider request.

import type {
  CompactionSummary,
  ContextSnapshot,
  MemoryContinuityAssessment,
  MemoryContinuitySource,
  Message,
  ModelRequestSnapshot,
  ReplyProvenance,
  RuntimeMemoryContextWorkingSet,
  RuntimeMemoryKnownState,
  TaskBook,
  ToolResult,
} from '@littlesheep/types';
import { resolveResponseContinuityExposure } from './response-continuity-exposure.js';
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
const MAX_DIAGNOSTIC_SIGNALS = 8;
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

/** Assess whether the actual reply contains evidence available only from prior context. */
export function assessResponseMemoryContinuity(
  input: ResponseContinuityInput,
): MemoryContinuityAssessment {
  const exposure = resolveResponseContinuityExposure({
    replyProvenance: input.replyProvenance,
    modelRequests: input.modelRequests,
    contextSnapshots: input.contextSnapshots,
    sessionSummaryId: input.sessionSummary?.id,
    toolResults: input.toolResults,
  });
  const replyTerms = continuityTerms(input.reply);
  const inboundTerms = continuityTerms(continuityMessageText(input.inbound));
  const currentRequestTerms = continuityTerms(continuityMessageText(input.inbound));
  const taskTerms = continuityTerms([
    continuityMessageText(input.inbound),
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
  const summaryTerms = withoutContinuityTerms(
    continuityTerms(exposure.sessionSummaryIncluded ? input.sessionSummary?.summary : undefined),
    currentRequestTerms,
  );

  const references = input.memoryKnownState?.references ?? [];
  const adoptedReferences = references.filter((reference) => reference.decision === 'adopted');
  const excludedOrConflictedReferences = references.length - adoptedReferences.length;
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
  // Marked Context is authoritative per Atom. Its surrounding headings are
  // transport scaffolding and must not keep a released Atom "continuous".
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
  const memoryAnchorCount = atomMemoryAnchorCount + unscopedMemoryOverlap.count;
  const summaryOverlap = continuityOverlap(replyTerms, summaryTerms);
  const historyOverlap = continuityOverlap(replyTerms, historyTerms);
  const taskOverlap = continuityOverlap(replyTerms, taskTerms);
  const requestOverlap = continuityOverlap(replyTerms, currentRequestTerms);
  const strongUnscopedMemoryAnchor = strongContinuityAnchor(unscopedMemoryOverlap);
  const strongSummaryAnchor = strongContinuityAnchor(summaryOverlap);
  const strongHistoryAnchor = strongContinuityAnchor(historyOverlap);
  const activeMemoryAtoms = eligibleAtomIds.size;
  const hasTextEvidence = atomTexts.length > 0
    || unscopedMemoryTerms.size > 0
    || summaryTerms.size > 0
    || historyTerms.size > 0;
  const hasMemoryMetadata = references.length > 0;
  const initialContext = Boolean(initialMemoryContext?.trim());
  const sessionSummary = Boolean(exposure.sessionSummaryIncluded && input.sessionSummary?.summary.trim());
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const referencedAtomIds = references
    .map((reference) => reference.atomId)
    .slice(0, MAX_REFERENCED_ATOMS);
  const independentContinuityAnchorCount = memoryAnchorCount
    + summaryOverlap.count
    + historyOverlap.count;

  const base = {
    version: 1 as const,
    confidence: 1,
    evaluatedAt,
    method: 'answer-evidence-v1' as const,
    sources: {
      initialContext,
      sessionSummary,
      recentHistoryMessages: recentHistory.length,
      contextObserved: exposure.observed,
      observedContextSnapshots: exposure.snapshots,
      contextItemsTruncated: exposure.truncated,
      memoryToolResults: exposure.memoryToolResults,
      activeMemoryAtoms,
      adoptedMemoryReferences: adoptedReferences.length,
      excludedOrConflictedReferences,
    },
    evidence: {
      replyTermCount: replyTerms.size,
      memoryTermCount: atomTexts.reduce((total, atom) => total + continuityTerms(atom.text).size, 0)
        + unscopedMemoryTerms.size,
      memoryAnchorCount,
      summaryAnchorCount: summaryOverlap.count,
      historyAnchorCount: historyOverlap.count,
      taskAnchorCount: taskOverlap.count,
      independentContinuityAnchorCount,
    },
    matchedSignals: [] as string[],
    missingSignals: [] as string[],
    matchedSources: [] as MemoryContinuitySource[],
    matchedAtomIds,
    referencedAtomIds,
  };

  if (replyTerms.size === 0) {
    return {
      ...base,
      status: 'unavailable',
      confidence: 0.98,
      missingSignals: ['final_reply_not_available_for_comparison'],
    };
  }

  if (exposure.strict && !exposure.observed) {
    return {
      ...base,
      status: 'unavailable',
      confidence: 0.98,
      missingSignals: ['reply_context_observability_unavailable'],
    };
  }

  if (exposure.truncated && !hasTextEvidence) {
    return {
      ...base,
      status: 'unavailable',
      confidence: 0.9,
      missingSignals: ['context_observability_truncated'],
    };
  }

  if (!hasTextEvidence && !hasMemoryMetadata) {
    return {
      ...base,
      status: 'not_applicable',
      matchedSignals: ['no_prior_memory_or_conversation_evidence'],
      missingSignals: ['no_continuity_source_to_compare'],
    };
  }

  if (!hasTextEvidence && hasMemoryMetadata) {
    return {
      ...base,
      status: 'unavailable',
      confidence: 0.95,
      matchedSignals: ['memory_metadata_present'],
      missingSignals: ['memory_text_not_available_for_reply_comparison'],
    };
  }

  const matchedSignals: string[] = [];
  const missingSignals: string[] = [];
  const matchedSources: MemoryContinuitySource[] = [];
  if (initialContext) matchedSignals.push('initial_memory_context_compared');
  if (sessionSummary) matchedSignals.push('session_summary_compared');
  if (exposure.memoryToolResults > 0) matchedSignals.push('memory_tool_results_compared');
  if (exposure.truncated) missingSignals.push('context_observability_truncated');
  if (matchedAtomIds.length > 0 || strongUnscopedMemoryAnchor) {
    matchedSignals.push('reply_uses_active_selected_memory');
    matchedSources.push('active_memory_atom');
  }
  if (strongSummaryAnchor) {
    matchedSignals.push('reply_uses_session_summary');
    matchedSources.push('session_summary');
  }
  if (strongHistoryAnchor) {
    matchedSignals.push('reply_continues_recent_conversation');
    matchedSources.push('recent_history');
  }
  if (taskOverlap.count >= 2) matchedSignals.push('reply_matches_current_task');
  if ((activeMemoryAtoms > 0 || unscopedMemoryTerms.size > 0) && matchedSources[0] !== 'active_memory_atom') {
    missingSignals.push('no_independent_active_memory_anchor');
  }
  if (summaryTerms.size > 0 && !strongSummaryAnchor) missingSignals.push('no_independent_summary_anchor');
  if (historyTerms.size > 0 && !strongHistoryAnchor) missingSignals.push('no_independent_recent_history_anchor');
  if (inboundTerms.size > 0 && requestOverlap.count >= 2 && independentContinuityAnchorCount === 0) {
    missingSignals.push('reply_only_matches_current_request');
  }
  if (matchedSignals.length === 0) matchedSignals.push('continuity_sources_were_available');
  if (missingSignals.length === 0) missingSignals.push('no_missing_continuity_signal_detected');

  const supported = matchedSources.length > 0;
  return {
    ...base,
    status: supported ? 'supported' : 'uncertain',
    confidence: supported
      ? Math.min(0.98, 0.7 + Math.min(0.2, independentContinuityAnchorCount * 0.035))
      : 0.46,
    matchedSignals: matchedSignals.slice(0, MAX_DIAGNOSTIC_SIGNALS),
    missingSignals: missingSignals.slice(0, MAX_DIAGNOSTIC_SIGNALS),
    matchedSources,
  };
}
