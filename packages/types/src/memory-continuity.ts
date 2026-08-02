// Run-level evidence about whether a user-visible reply remains connected to
// the memory and conversation context available to the run.

export type MemoryContinuityStatus =
  | 'supported'
  | 'discontinuous'
  | 'uncertain'
  | 'not_applicable'
  | 'unavailable';

export type MemoryContinuitySource =
  | 'active_memory_atom'
  | 'session_summary'
  | 'recent_history';

/**
 * A bounded, local assessment. `confidence` describes confidence in the
 * assessment, not a guarantee that the reply is factually correct.
 */
export interface MemoryContinuityAssessment {
  version: 1;
  status: MemoryContinuityStatus;
  confidence: number;
  evaluatedAt: string;
  method: 'answer-evidence-v1';
  sources: {
    initialContext: boolean;
    sessionSummary: boolean;
    recentHistoryMessages: number;
    explicitContinuationRequest: boolean;
    contextObserved: boolean;
    observedContextSnapshots: number;
    contextItemsTruncated: boolean;
    memoryToolResults: number;
    activeMemoryAtoms: number;
    adoptedMemoryReferences: number;
    excludedOrConflictedReferences: number;
  };
  evidence: {
    replyTermCount: number;
    memoryTermCount: number;
    memoryAnchorCount: number;
    summaryAnchorCount: number;
    historyAnchorCount: number;
    taskAnchorCount: number;
    independentContinuityAnchorCount: number;
  };
  /** Short diagnostic labels only; no prompt or reply body is copied here. */
  matchedSignals: string[];
  missingSignals: string[];
  matchedSources: MemoryContinuitySource[];
  /** Active, adopted atoms whose content has independent anchors in the reply. */
  matchedAtomIds: string[];
  referencedAtomIds: string[];
}
