// Fit one assembled request into its token budget.
//
// Two measurements guard a request, and they are not interchangeable: an exact
// counter may enforce the smaller stage target without over-pruning Context,
// while the conservative estimator only guards the hard model window. Both drop
// the same optional units, in the same order, and both must fail loudly rather
// than silently shrink a request past what the caller already sent.
import type { ContextSafetyEstimate } from '@littlesheep/types';
import type { ChatRequest } from '@littlesheep/llm';
import type { ContextEvictionState, ContextOmissionUnit } from './eviction.js';
import { evictOptionalContext } from './eviction.js';
import type { ContextMessageCandidate, ExactContextTokenCounter } from './contracts.js';
import { ContextBudgetExceededError, ContextSafetyEstimationError } from './contracts.js';
import { buildSafetyEstimate, validTokenCount } from './counting.js';

export interface ContextSafetyEstimatorLike {
  id: string;
  estimatePromptTokens(request: ChatRequest): number;
}

export interface FitRequestInput {
  state: ContextEvictionState;
  baseRequest: ChatRequest;
  candidates: ContextMessageCandidate[];
  omitted: Set<string>;
  optional: ContextOmissionUnit[];
  targetPromptTokens?: number;
  /** The hard model window; only this may turn a shortfall into a failure. */
  availablePromptTokens?: number;
  counter?: ExactContextTokenCounter;
  estimator: ContextSafetyEstimatorLike;
  provider: string;
  model: string;
  createdAt: string;
}

export interface FitRequestOutcome {
  promptTokens?: number;
  /**
   * What the request measured before any eviction. A caller that wants to know
   * whether the *model window* forced the drop (as opposed to a stage's soft
   * target) compares this against `availablePromptTokens`.
   */
  promptTokensBeforeFit?: number;
  counterFailure?: string;
  safetyEstimate?: ContextSafetyEstimate;
}

export function fitRequestToBudget(input: FitRequestInput): FitRequestOutcome {
  const { state } = input;
  const outcome: FitRequestOutcome = {};
  const failIfOverWindow = (measurement: 'exact' | 'conservative_estimate'): void => {
    if (input.availablePromptTokens === undefined) return;
    if (state.measurement <= input.availablePromptTokens) return;
    throw measurement === 'exact'
      ? new ContextBudgetExceededError(state.measurement, input.availablePromptTokens)
      : new ContextBudgetExceededError(state.measurement, input.availablePromptTokens, measurement);
  };
  const evict = (limit: number, measure: (request: ChatRequest) => number): void => {
    evictOptionalContext(state, input.baseRequest, input.candidates, input.omitted, input.optional, limit, measure);
  };

  if (input.counter) {
    const counter = input.counter;
    try {
      state.measurement = validTokenCount(counter.countRequest(state.request), 'exact token counter');
      outcome.promptTokensBeforeFit = state.measurement;
      if (input.targetPromptTokens !== undefined && state.measurement > input.targetPromptTokens) {
        evict(input.targetPromptTokens, (request) => (
          validTokenCount(counter.countRequest(request), 'exact token counter')
        ));
        failIfOverWindow('exact');
      }
      outcome.promptTokens = state.measurement;
    } catch (error) {
      if (error instanceof ContextBudgetExceededError) throw error;
      outcome.counterFailure = (error as Error).message;
    }
  }

  // Conservative estimates guard the hard model window; only exact counters may
  // enforce the smaller stage target without over-pruning Context.
  const safetyPromptTokens = input.availablePromptTokens ?? input.targetPromptTokens;
  if (outcome.promptTokens === undefined && safetyPromptTokens !== undefined) {
    const estimator = input.estimator;
    try {
      state.measurement = validTokenCount(
        estimator.estimatePromptTokens(state.request),
        'context safety estimator',
      );
      outcome.promptTokensBeforeFit ??= state.measurement;
      if (state.measurement > safetyPromptTokens) {
        evict(safetyPromptTokens, (request) => (
          validTokenCount(estimator.estimatePromptTokens(request), 'context safety estimator')
        ));
        failIfOverWindow('conservative_estimate');
      }
      outcome.safetyEstimate = buildSafetyEstimate({
        provider: input.provider,
        model: input.model,
        estimatorId: estimator.id,
        estimatedPromptTokens: state.measurement,
        calculatedAt: input.createdAt,
      });
    } catch (error) {
      if (error instanceof ContextBudgetExceededError) throw error;
      throw new ContextSafetyEstimationError(estimator.id, (error as Error).message);
    }
  }
  return outcome;
}
