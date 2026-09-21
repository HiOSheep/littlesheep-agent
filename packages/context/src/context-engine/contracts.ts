import type {
  ModelContextWindowCapability,
  ModelTokenizerCapability,
} from '@littlesheep/config';
import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import type {
  ContextItemKind,
  ContextScope,
  ContextSnapshot,
  ContextSourceRef,
  LlmCallContract,
  ModelRequestSnapshot,
  SessionId,
  StageName,
} from '@littlesheep/types';

export const MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN = 64;
export const MAX_SNAPSHOT_MESSAGES = 64;
export const MAX_SNAPSHOT_ITEMS = 64;
export const MAX_SNAPSHOT_TOOLS = 64;
export const DEFAULT_COMPRESSION_THRESHOLD_RATIO = 0.8;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4_096;
export const DEFAULT_IMAGE_PROMPT_TOKEN_SAFETY_RESERVE = 32_768;
export const DEFAULT_REQUEST_PROMPT_TOKEN_SAFETY_RESERVE = 512;
export const DEFAULT_CONTEXT_SAFETY_ESTIMATOR_ID = 'openai-compatible-utf8-bytes-plus-image-reserve-v1';

export interface ExactContextTokenCounter {
  readonly id: string;
  supports(provider: string, model: string): boolean;
  countRequest(request: ChatRequest): number;
}

export interface ContextSafetyEstimator {
  readonly id: string;
  estimatePromptTokens(request: ChatRequest): number;
}

export interface ContextMessageCandidate {
  id: string;
  order: number;
  message: ChatMessage;
  kind: ContextItemKind;
  source: ContextSourceRef;
  priority: number;
  required: boolean;
  sensitive: boolean;
  scope?: ContextScope;
  /** Optional eviction group; members are omitted together. */
  evictionGroup?: string;
  segments?: ContextMessageSegment[];
}

export interface ContextMessageSegment {
  id: string;
  order: number;
  text: string;
  kind: ContextItemKind;
  source: ContextSourceRef;
  priority: number;
  required: boolean;
  sensitive: boolean;
  scope?: ContextScope;
  /** Optional eviction group for a set of prompt segments. */
  evictionGroup?: string;
  /**
   * A section the caller's append-only tail owns: it is emitted once as its own
   * message instead of being folded into a single-request system message, so a
   * changed section can only be appended and never move an earlier one.
   */
  placement?: 'trailing';
}

export interface PrepareContextRequestInput {
  runId: string;
  sessionId: SessionId;
  stage: StageName;
  requestIndex: number;
  request: ChatRequest;
  provider?: string;
  candidates?: ContextMessageCandidate[];
  callContract?: LlmCallContract;
  compressionThresholdRatio?: number;
  /**
   * Which Context items budget eviction may drop.
   *
   * `unconsumed` (default) keeps the historical behaviour. `appended-only`
   * protects everything the caller has already sent, so a caller extending a
   * sent request cannot have it silently re-numbered; the budget is then either
   * satisfied by dropping appended items or reported as exceeded.
   */
  evictionScope?: 'unconsumed' | 'appended-only';
  /** Candidate ids that must not be evicted under `appended-only`. */
  protectedCandidateIds?: readonly string[];
}

export interface PreparedContextRequest {
  request: ChatRequest;
  modelRequestSnapshot: ModelRequestSnapshot;
  contextSnapshot: ContextSnapshot;
  compressionRecommended: boolean;
  omittedCandidateIds: string[];
}

export interface ContextEngineOptions {
  tokenCounter?: ExactContextTokenCounter;
  safetyEstimator?: ContextSafetyEstimator;
  resolveContextWindow?: (
    provider: string,
    model: string,
  ) => ModelContextWindowCapability | undefined;
  resolveTokenizerCapability?: (
    provider: string,
    model: string,
  ) => ModelTokenizerCapability | undefined;
}

export class ContextBudgetExceededError extends Error {
  readonly promptTokens: number;
  readonly availablePromptTokens: number;
  readonly measurement: 'exact' | 'conservative_estimate';

  constructor(
    promptTokens: number,
    availablePromptTokens: number,
    measurement: 'exact' | 'conservative_estimate' = 'exact',
  ) {
    super(measurement === 'exact'
      ? `Required context uses ${promptTokens} tokens but only ${availablePromptTokens} are available.`
      : `Required context exceeds the conservative safety budget (${promptTokens} estimated prompt tokens against ${availablePromptTokens} available).`);
    this.name = 'ContextBudgetExceededError';
    this.promptTokens = promptTokens;
    this.availablePromptTokens = availablePromptTokens;
    this.measurement = measurement;
  }
}

export class ContextSafetyEstimationError extends Error {
  constructor(estimatorId: string, reason: string) {
    super(`Context safety estimator ${estimatorId} failed: ${reason}`);
    this.name = 'ContextSafetyEstimationError';
  }
}

export type ContextContractViolationReason =
  | 'forbidden_model_call'
  | 'stage_mismatch'
  | 'required_context_forbidden'
  | 'required_context_missing';

/** Raised when outbound Context would violate the resolved model-call contract. */
export class ContextContractViolationError extends Error {
  readonly contractId: string;
  readonly reason: ContextContractViolationReason;
  readonly contextKind?: ContextItemKind;
  readonly candidateId?: string;

  constructor(
    contract: LlmCallContract,
    reason: ContextContractViolationReason,
    details: { contextKind?: ContextItemKind; candidateId?: string; message: string },
  ) {
    super(`LLM call contract ${contract.id} rejected Context: ${details.message}`);
    this.name = 'ContextContractViolationError';
    this.contractId = contract.id;
    this.reason = reason;
    this.contextKind = details.contextKind;
    this.candidateId = details.candidateId;
  }
}
