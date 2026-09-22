// Stable facade for deterministic context budgeting, assembly and snapshots.
import { resolveModelContextWindow, resolveModelTokenizerCapability } from '@littlesheep/config';
import { requestFromCandidates } from './context-engine/assembly.js';
import { AppendOnlyLedger, protectedCandidateIds } from './context-engine/append-only.js';
import { resolveContextBudget, shouldRecommendCompression } from './context-engine/budget.js';
import { prepareContextCandidates } from './context-engine/contract-policy.js';
import {
  type ContextEngineOptions,
  type PrepareContextRequestInput,
  type PreparedContextRequest,
} from './context-engine/contracts.js';
import { defaultContextSafetyEstimator, resolveExactCounter } from './context-engine/counting.js';
import { optionalOmissionUnits } from './context-engine/eviction.js';
import { fitRequestToBudget, type FitRequestOutcome } from './context-engine/fit.js';
import { ContextReuseCache, resolveContextReuse, storeContextReuse } from './context-engine/reuse-cache.js';
import { buildPreparedSnapshots } from './context-engine/snapshots.js';
export * from './context-engine/contracts.js';
export { defaultContextSafetyEstimator } from './context-engine/counting.js';
export class ContextEngine {
  private readonly tokenCounter: ContextEngineOptions['tokenCounter'];
  private readonly safetyEstimator: NonNullable<ContextEngineOptions['safetyEstimator']>;
  private readonly resolveContextWindow: NonNullable<ContextEngineOptions['resolveContextWindow']>;
  private readonly resolveTokenizerCapability: NonNullable<ContextEngineOptions['resolveTokenizerCapability']>;
  private readonly reuseCache = new ContextReuseCache();
  /** What each run+stage request delivered, so `appended-only` can protect it. */
  private readonly appendOnly = new AppendOnlyLedger();
  constructor(options: ContextEngineOptions = {}) {
    this.tokenCounter = options.tokenCounter;
    this.safetyEstimator = options.safetyEstimator ?? defaultContextSafetyEstimator;
    this.resolveContextWindow = options.resolveContextWindow ?? resolveModelContextWindow;
    this.resolveTokenizerCapability = options.resolveTokenizerCapability ?? resolveModelTokenizerCapability;
  }
  prepare(input: PrepareContextRequestInput): PreparedContextRequest {
    const createdAt = new Date().toISOString();
    const budget = resolveContextBudget(input, this.resolveContextWindow);
    const candidates = prepareContextCandidates(input);
    // Under `appended-only`, everything the caller has already sent is
    // protected: eviction may drop what this request appended, never an item
    // whose removal would re-number the messages around it.
    const protectedIds = budget.evictionScope === 'appended-only'
      ? protectedCandidateIds(input, this.appendOnly.read(input.runId, input.stage))
      : new Set<string>();
    const reuse = resolveContextReuse(input, candidates, budget, this.reuseCache, protectedIds);
    // An identical assembly reuses the eviction decision, token measurement and
    // estimator outcome instead of re-deriving them; that local reuse is the
    // real event the Runtime reports as its context-cache ledger.
    const reused = reuse.entry;
    const counterResolution = resolveExactCounter(
      this.resolveTokenizerCapability(budget.provider, budget.model),
      this.tokenCounter,
      budget.provider,
      budget.model,
    );
    const omitted = new Set<string>(reused?.omitted ?? []);
    const optional = optionalOmissionUnits(candidates, protectedIds);
    const state = {
      request: requestFromCandidates(input.request, candidates, omitted),
      measurement: reused?.measurement ?? 0,
    };
    const targetPromptTokens = budget.targetPromptTokens ?? budget.availablePromptTokens;
    // A reused assembly keeps its measurement and estimator outcome; a rebuilt
    // one is measured and, if needed, trimmed to fit before it is sent.
    const fitted: FitRequestOutcome = reused
      ? {
          ...(reused.promptTokens === undefined ? {} : { promptTokens: reused.promptTokens }),
          ...(reused.counterFailure === undefined ? {} : { counterFailure: reused.counterFailure }),
          ...(reused.safetyEstimate === undefined ? {} : { safetyEstimate: reused.safetyEstimate }),
        }
      : fitRequestToBudget({
          state,
          baseRequest: input.request,
          candidates,
          omitted,
          optional,
          ...(targetPromptTokens === undefined ? {} : { targetPromptTokens }),
          ...(budget.availablePromptTokens === undefined
            ? {}
            : { availablePromptTokens: budget.availablePromptTokens }),
          ...(counterResolution.counter === undefined ? {} : { counter: counterResolution.counter }),
          estimator: this.safetyEstimator,
          provider: budget.provider,
          model: budget.model,
          createdAt,
        });
    const promptTokens = fitted.promptTokens;
    const counterFailure = fitted.counterFailure;
    const safetyEstimate = fitted.safetyEstimate;

    // Fitting to the budget drops candidates, and every drop moves the request's
    // history window, so the next turn no longer extends the previous request and
    // the Provider re-bills the prefix. That is what compaction exists for, but the
    // *fitted* prompt sits below the ratio, so comparing the fitted count alone
    // never reports the pressure that caused the drop: the session then evicts a
    // little on every turn instead of folding once.
    //
    // Only the model window counts as that pressure. A stage's own soft target may
    // also drop optional context, and folding the session summary because a narrow
    // stage asked for a small prompt would be wrong.
    const overModelWindow = fitted.promptTokensBeforeFit !== undefined
      && budget.availablePromptTokens !== undefined
      && fitted.promptTokensBeforeFit > budget.availablePromptTokens;
    const compressionRecommended = overModelWindow || shouldRecommendCompression(
      promptTokens ?? safetyEstimate?.estimatedPromptTokens,
      budget.availablePromptTokens,
      budget.compressionThresholdRatio,
    );
    if (!reused) {
      storeContextReuse(this.reuseCache, reuse, {
        omitted: [...omitted],
        measurement: state.measurement,
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(safetyEstimate === undefined ? {} : { safetyEstimate }),
        ...(counterFailure === undefined ? {} : { counterFailure }),
      });
    }
    if (budget.evictionScope === 'appended-only') {
      this.appendOnly.remember(input.runId, input.stage, candidates, omitted);
    }
    const { contextSnapshot, modelRequestSnapshot } = buildPreparedSnapshots({
      runId: input.runId,
      sessionId: input.sessionId,
      stage: input.stage,
      requestIndex: input.requestIndex,
      provider: budget.provider,
      model: budget.model,
      createdAt,
      capability: budget.capability,
      reservedOutputTokens: budget.reservedOutputTokens,
      availablePromptTokens: budget.availablePromptTokens,
      compressionThresholdRatio: budget.compressionThresholdRatio,
      candidates,
      omitted,
      compressionRecommended,
      safetyEstimate,
      promptTokens,
      contextReuse: reuse.event,
      request: state.request,
      callContract: input.callContract,
      exactCounterId: counterResolution.counter?.id,
      unavailableCounterReason: counterFailure
        ? `Exact token counter ${counterResolution.counter?.id ?? 'unknown'} failed: ${counterFailure}`
        : counterResolution.reason,
    });
    return {
      request: state.request,
      modelRequestSnapshot,
      contextSnapshot,
      compressionRecommended,
      omittedCandidateIds: [...omitted],
    };
  }
}
