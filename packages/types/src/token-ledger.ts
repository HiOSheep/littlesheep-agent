// Token ledgers separate exact local assembly, provider-reported usage, and
// non-displayable overflow estimates while preserving same-request calibration.

export interface ExactLocalTokenLedger {
  version: 1;
  source: 'local';
  accuracy: 'exact';
  provider: string;
  model: string;
  tokenizerId: string;
  promptTokens: number;
  countedAt: string;
}

export interface UnavailableLocalTokenLedger {
  version: 1;
  source: 'local';
  accuracy: 'unavailable';
  provider: string;
  model: string;
  reason: string;
  countedAt: string;
}

export type LocalTokenLedger = ExactLocalTokenLedger | UnavailableLocalTokenLedger;

/** Internal overflow protection only. This estimate is never a displayable token ledger. */
export interface ContextSafetyEstimate {
  version: 1;
  source: 'local';
  accuracy: 'conservative';
  purpose: 'overflow_protection';
  provider: string;
  model: string;
  estimatorId: string;
  estimatedPromptTokens: number;
  calculatedAt: string;
  displayable: false;
}

export interface ProviderLocalTokenCalibration {
  version: 1;
  tokenizerId: string;
  localPromptTokens: number;
  differenceTokens: number;
  relativeDifference: number;
  status: 'exact_match' | 'within_tolerance' | 'drift';
}

export interface ProviderTokenLedger {
  version: 1;
  source: 'provider';
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  /** Provider-reported prompt tokens that missed the cache; disjoint from cachedPromptTokens. */
  uncachedPromptTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Wall-clock time spent awaiting this Provider request. */
  durationMs?: number;
  requestElapsedMs?: number;
  transportAttempt?: number;
  observedAttemptCount?: number;
  ttftMs?: number;
  contentTtftMs?: number;
  reasoningTtftMs?: number;
  toolArgumentsTtftMs?: number;
  requestId?: string;
  /** Detects tokenizer drift without replacing the current local assembly value. */
  localCalibration?: ProviderLocalTokenCalibration;
  reportedAt: string;
}

export type TokenLedger = LocalTokenLedger | ProviderTokenLedger;

/** Returns a prompt-token value only when its source is explicitly trustworthy. */
export function getDisplayablePromptTokens(ledger: TokenLedger | undefined): number | undefined {
  if (!ledger) return undefined;
  if (ledger.source === 'provider') return ledger.promptTokens;
  return ledger.accuracy === 'exact' ? ledger.promptTokens : undefined;
}
