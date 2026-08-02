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
import type { ResponseContinuityExposure } from './response-continuity-exposure.js';

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
  requestedValueTargetCount: number;
  requestedValueMatchedCount: number;
  replyDisclaimsContinuity: boolean;
  matchedAtomIds: string[];
  referencedAtomIds: string[];
}
