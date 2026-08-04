// Local, bounded continuity verdict for a user-visible reply candidate.
// This pure evidence check does not call a model or mutate the run. A caller
// may use a discontinuous verdict to request one bounded Provider correction.

import type {
  MemoryContinuityAssessment,
  MemoryContinuitySource,
} from '@littlesheep/types';
import {
  collectResponseContinuityEvidence,
} from './response-continuity-evidence.js';
import type { ResponseContinuityInput } from './response-continuity-types.js';

const MAX_DIAGNOSTIC_SIGNALS = 8;

export type { ResponseContinuityInput } from './response-continuity-types.js';

/** Assess whether the actual reply remains connected to its causal prior Context. */
export function assessResponseMemoryContinuity(
  input: ResponseContinuityInput,
): MemoryContinuityAssessment {
  const comparison = collectResponseContinuityEvidence(input);
  const base = {
    version: 1 as const,
    confidence: 1,
    evaluatedAt: comparison.evaluatedAt,
    method: 'answer-evidence-v1' as const,
    sources: {
      initialContext: comparison.initialContext,
      sessionSummary: comparison.sessionSummary,
      recentHistoryMessages: comparison.recentHistoryMessages,
      explicitContinuationRequest: comparison.explicitContinuationRequest,
      contextObserved: comparison.exposure.observed,
      observedContextSnapshots: comparison.exposure.snapshots,
      contextItemsTruncated: comparison.exposure.truncated,
      memoryToolResults: comparison.exposure.memoryToolResults,
      activeMemoryAtoms: comparison.activeMemoryAtoms,
      adoptedMemoryReferences: comparison.adoptedMemoryReferences,
      excludedOrConflictedReferences: comparison.excludedOrConflictedReferences,
    },
    evidence: {
      replyTermCount: comparison.replyTermCount,
      memoryTermCount: comparison.memoryTermCount,
      memoryAnchorCount: comparison.memoryAnchorCount,
      summaryAnchorCount: comparison.summaryAnchorCount,
      historyAnchorCount: comparison.historyAnchorCount,
      taskAnchorCount: comparison.taskOverlapCount,
      independentContinuityAnchorCount: comparison.independentContinuityAnchorCount,
    },
    matchedSignals: [] as string[],
    missingSignals: [] as string[],
    matchedSources: [] as MemoryContinuitySource[],
    matchedAtomIds: comparison.matchedAtomIds,
    referencedAtomIds: comparison.referencedAtomIds,
  };

  if (comparison.replyTermCount === 0) {
    return {
      ...base,
      status: 'unavailable',
      confidence: 0.98,
      missingSignals: ['final_reply_not_available_for_comparison'],
    };
  }

  if (comparison.exposure.strict && !comparison.exposure.observed) {
    return {
      ...base,
      status: 'unavailable',
      confidence: 0.98,
      missingSignals: ['reply_context_observability_unavailable'],
    };
  }

  if (comparison.exposure.truncated && !comparison.hasTextEvidence) {
    return {
      ...base,
      status: 'unavailable',
      confidence: 0.9,
      missingSignals: ['context_observability_truncated'],
    };
  }

  if (!comparison.hasTextEvidence && !comparison.hasMemoryMetadata) {
    if (comparison.explicitContinuationRequest) {
      return {
        ...base,
        status: 'unavailable',
        confidence: 0.95,
        matchedSignals: ['explicit_continuation_requested'],
        missingSignals: ['continuation_target_not_available_for_comparison'],
      };
    }
    return {
      ...base,
      status: 'not_applicable',
      matchedSignals: ['no_prior_memory_or_conversation_evidence'],
      missingSignals: ['no_continuity_source_to_compare'],
    };
  }

  if (!comparison.hasTextEvidence && comparison.hasMemoryMetadata) {
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
  if (comparison.initialContext) matchedSignals.push('initial_memory_context_compared');
  if (comparison.sessionSummary) matchedSignals.push('session_summary_compared');
  if (comparison.exposure.memoryToolResults > 0) matchedSignals.push('memory_tool_results_compared');
  if (comparison.exposure.truncated) missingSignals.push('context_observability_truncated');
  if (comparison.strongMemoryAnchor && !comparison.replyDisclaimsContinuity) {
    matchedSignals.push('reply_uses_active_selected_memory');
    matchedSources.push('active_memory_atom');
  }
  if (comparison.strongSummaryAnchor && !comparison.replyDisclaimsContinuity) {
    matchedSignals.push('reply_uses_session_summary');
    matchedSources.push('session_summary');
  }
  if (comparison.strongHistoryAnchor && !comparison.replyDisclaimsContinuity) {
    matchedSignals.push('reply_continues_recent_conversation');
    matchedSources.push('recent_history');
  }
  if (comparison.taskOverlapCount >= 2) matchedSignals.push('reply_matches_current_task');
  if (comparison.memoryTermsAvailable && !matchedSources.includes('active_memory_atom')) {
    missingSignals.push('no_independent_active_memory_anchor');
  }
  if (comparison.summaryTermsAvailable && !comparison.strongSummaryAnchor) {
    missingSignals.push('no_independent_summary_anchor');
  }
  if (comparison.historyTermsAvailable && !comparison.strongHistoryAnchor) {
    missingSignals.push('no_independent_recent_history_anchor');
  }
  if (
    comparison.inboundTermCount > 0
    && comparison.requestOverlapCount >= 2
    && comparison.independentContinuityAnchorCount === 0
  ) {
    missingSignals.push('reply_only_matches_current_request');
  }
  if (comparison.explicitContinuationRequest && !comparison.hasContinuationTargetEvidence) {
    matchedSignals.push('explicit_continuation_requested');
    missingSignals.push('continuation_target_not_available_for_comparison');
  }
  const requestedValuesIncomplete = comparison.requestedValueTargetCount > 0
    && comparison.requestedValueMatchedCount < comparison.requestedValueTargetCount;
  const continuationTargetMatched = comparison.continuationTargetMatched
    && !comparison.replyDisclaimsContinuity;
  const discontinuous = comparison.explicitContinuationRequest
    && comparison.hasContinuationTargetEvidence
    && (
      comparison.replyDisclaimsContinuity
      || (
        !comparison.continuationTargetMatched
        && (
          requestedValuesIncomplete
          || comparison.continuationTargetOverlapCount === 0
        )
      )
    )
    && !comparison.exposure.truncated;
  if (discontinuous) {
    matchedSignals.push('explicit_continuation_requested');
    missingSignals.push('explicit_continuation_not_reflected_in_reply');
  }
  if (matchedSignals.length === 0) matchedSignals.push('continuity_sources_were_available');
  if (missingSignals.length === 0) missingSignals.push('no_missing_continuity_signal_detected');

  const supported = comparison.explicitContinuationRequest
    ? continuationTargetMatched
    : matchedSources.length > 0;
  return {
    ...base,
    status: supported ? 'supported' : discontinuous ? 'discontinuous' : 'uncertain',
    confidence: supported
      ? Math.min(0.98, 0.7 + Math.min(0.2, comparison.independentContinuityAnchorCount * 0.035))
      : discontinuous ? 0.88
      : 0.46,
    matchedSignals: matchedSignals.slice(0, MAX_DIAGNOSTIC_SIGNALS),
    missingSignals: missingSignals.slice(0, MAX_DIAGNOSTIC_SIGNALS),
    matchedSources,
  };
}
