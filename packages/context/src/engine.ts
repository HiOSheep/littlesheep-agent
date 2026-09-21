// Stable facade for deterministic context budgeting, assembly and snapshots.
import { resolveModelContextWindow, resolveModelTokenizerCapability } from '@littlesheep/config';
import type { ContextSafetyEstimate } from '@littlesheep/types';
import { requestFromCandidates } from './context-engine/assembly.js';
import { resolveContextBudget, shouldRecommendCompression } from './context-engine/budget.js';
import { prepareContextCandidates } from './context-engine/contract-policy.js';
import {
  ContextBudgetExceededError,
  ContextSafetyEstimationError,
  type ContextEngineOptions,
  type PrepareContextRequestInput,
  type PreparedContextRequest,
} from './context-engine/contracts.js';
import { buildSafetyEstimate, defaultContextSafetyEstimator, resolveExactCounter, validTokenCount } from './context-engine/counting.js';
import { deliveredUnitIds, evictOptionalContext, optionalOmissionUnits } from './context-engine/eviction.js';
import { ContextReuseCache, resolveContextReuse, storeContextReuse } from './context-engine/reuse-cache.js';
import { buildPreparedSnapshots } from './context-engine/snapshots.js';
export * from './context-engine/contracts.js';
export { defaultContextSafetyEstimator } from './context-engine/counting.js';
/**
 * The candidate ids an `appended-only` request protects.
 *
 * Under that scope the caller is asking to extend a request it has already sent,
 * so everything the previous request for the same run and stage delivered is
 * protected; the caller may also name extra candidates it owns. What remains
 * evictable is exactly what this request appended.
 */
function protectedCandidateIds(
  input: PrepareContextRequestInput,
  delivered: ReadonlySet<string> | undefined,
): Set<string> {
  return new Set([...(delivered ?? []), ...(input.protectedCandidateIds ?? [])]);
}

/** Bounded number of run+stage append-only ledgers one engine instance keeps. */
const MAX_APPEND_ONLY_LEDGERS = 32;

export class ContextEngine {
  private readonly tokenCounter: ContextEngineOptions['tokenCounter'];
  private readonly safetyEstimator: NonNullable<ContextEngineOptions['safetyEstimator']>;
  private readonly resolveContextWindow: NonNullable<ContextEngineOptions['resolveContextWindow']>;
  private readonly resolveTokenizerCapability: NonNullable<ContextEngineOptions['resolveTokenizerCapability']>;
  private readonly reuseCache = new ContextReuseCache();
  /**
   * Per run+stage record of what the last assembled request delivered.
   *
   * It is the only state that makes `appended-only` eviction meaningful: the
   * engine, not the caller, knows which Context units the previous request
   * actually contained, so protection cannot drift from the sent bytes.
   */
  private readonly deliveredUnits = new Map<string, Set<string>>();
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
    const ledgerKey = `${input.runId}\u0000${input.stage}`;
    // Under `appended-only`, everything the caller has already sent is
    // protected: eviction may drop what this request appended, never an item
    // whose removal would re-number the messages around it.
    const protectedIds = budget.evictionScope === 'appended-only'
      ? protectedCandidateIds(input, this.deliveredUnits.get(ledgerKey))
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
    let promptTokens: number | undefined = reused?.promptTokens;
    let counterFailure: string | undefined = reused?.counterFailure;
    let safetyEstimate: ContextSafetyEstimate | undefined = reused?.safetyEstimate;

    if (!reused && counterResolution.counter) {
      try {
        state.measurement = validTokenCount(
          counterResolution.counter.countRequest(state.request),
          'exact token counter',
        );
        if (targetPromptTokens !== undefined && state.measurement > targetPromptTokens) {
          evictOptionalContext(
            state,
            input.request,
            candidates,
            omitted,
            optional,
            targetPromptTokens,
            (request) => validTokenCount(
              counterResolution.counter!.countRequest(request),
              'exact token counter',
            ),
          );
          if (budget.availablePromptTokens !== undefined && state.measurement > budget.availablePromptTokens) {
            throw new ContextBudgetExceededError(state.measurement, budget.availablePromptTokens);
          }
        }
        promptTokens = state.measurement;
      } catch (error) {
        if (error instanceof ContextBudgetExceededError) throw error;
        counterFailure = (error as Error).message;
      }
    }
    // Conservative estimates guard the hard model window; only exact counters
    // may enforce the smaller stage target without over-pruning Context.
    const safetyPromptTokens = budget.availablePromptTokens ?? targetPromptTokens;
    if (!reused && promptTokens === undefined && safetyPromptTokens !== undefined) {
      try {
        state.measurement = validTokenCount(
          this.safetyEstimator.estimatePromptTokens(state.request),
          'context safety estimator',
        );
        if (state.measurement > safetyPromptTokens) {
          evictOptionalContext(
            state,
            input.request,
            candidates,
            omitted,
            optional,
            safetyPromptTokens,
            (request) => validTokenCount(
              this.safetyEstimator.estimatePromptTokens(request),
              'context safety estimator',
            ),
          );
          if (budget.availablePromptTokens !== undefined && state.measurement > budget.availablePromptTokens) {
            throw new ContextBudgetExceededError(
              state.measurement,
              budget.availablePromptTokens,
              'conservative_estimate',
            );
          }
        }
        safetyEstimate = buildSafetyEstimate({
          provider: budget.provider,
          model: budget.model,
          estimatorId: this.safetyEstimator.id,
          estimatedPromptTokens: state.measurement,
          calculatedAt: createdAt,
        });
      } catch (error) {
        if (error instanceof ContextBudgetExceededError) throw error;
        throw new ContextSafetyEstimationError(this.safetyEstimator.id, (error as Error).message);
      }
    }

    const compressionRecommended = shouldRecommendCompression(
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
      this.rememberDelivered(ledgerKey, deliveredUnitIds(candidates, omitted));
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

  private rememberDelivered(ledgerKey: string, delivered: Set<string>): void {
    if (this.deliveredUnits.has(ledgerKey)) this.deliveredUnits.delete(ledgerKey);
    this.deliveredUnits.set(ledgerKey, delivered);
    while (this.deliveredUnits.size > MAX_APPEND_ONLY_LEDGERS) {
      const oldest = this.deliveredUnits.keys().next().value;
      if (oldest === undefined) break;
      this.deliveredUnits.delete(oldest);
    }
  }
}
