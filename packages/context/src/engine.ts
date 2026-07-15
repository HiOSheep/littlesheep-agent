// Stable facade for deterministic context budgeting, assembly and snapshots.
import {
  resolveModelContextWindow,
  resolveModelTokenizerCapability,
} from '@littlesheep/config';
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
import {
  defaultContextSafetyEstimator,
  resolveExactCounter,
  validTokenCount,
} from './context-engine/counting.js';
import { evictOptionalContext, optionalOmissionUnits } from './context-engine/eviction.js';
import { buildContextSnapshot, buildModelRequestSnapshot } from './context-engine/snapshots.js';

export * from './context-engine/contracts.js';
export { defaultContextSafetyEstimator } from './context-engine/counting.js';
export class ContextEngine {
  private readonly tokenCounter: ContextEngineOptions['tokenCounter'];
  private readonly safetyEstimator: NonNullable<ContextEngineOptions['safetyEstimator']>;
  private readonly resolveContextWindow: NonNullable<ContextEngineOptions['resolveContextWindow']>;
  private readonly resolveTokenizerCapability: NonNullable<ContextEngineOptions['resolveTokenizerCapability']>;

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
    const counterResolution = resolveExactCounter(
      this.resolveTokenizerCapability(budget.provider, budget.model),
      this.tokenCounter,
      budget.provider,
      budget.model,
    );
    const omitted = new Set<string>();
    const optional = optionalOmissionUnits(candidates);
    const state = {
      request: requestFromCandidates(input.request, candidates, omitted),
      measurement: 0,
    };
    let promptTokens: number | undefined;
    let counterFailure: string | undefined;
    let safetyEstimate: ContextSafetyEstimate | undefined;

    if (counterResolution.counter) {
      try {
        state.measurement = validTokenCount(
          counterResolution.counter.countRequest(state.request),
          'exact token counter',
        );
        if (budget.availablePromptTokens !== undefined && state.measurement > budget.availablePromptTokens) {
          evictOptionalContext(
            state,
            input.request,
            candidates,
            omitted,
            optional,
            budget.availablePromptTokens,
            (request) => validTokenCount(
              counterResolution.counter!.countRequest(request),
              'exact token counter',
            ),
          );
          if (state.measurement > budget.availablePromptTokens) {
            throw new ContextBudgetExceededError(state.measurement, budget.availablePromptTokens);
          }
        }
        promptTokens = state.measurement;
      } catch (error) {
        if (error instanceof ContextBudgetExceededError) throw error;
        counterFailure = (error as Error).message;
      }
    }

    if (promptTokens === undefined && budget.availablePromptTokens !== undefined) {
      try {
        state.measurement = validTokenCount(
          this.safetyEstimator.estimatePromptTokens(state.request),
          'context safety estimator',
        );
        if (state.measurement > budget.availablePromptTokens) {
          evictOptionalContext(
            state,
            input.request,
            candidates,
            omitted,
            optional,
            budget.availablePromptTokens,
            (request) => validTokenCount(
              this.safetyEstimator.estimatePromptTokens(request),
              'context safety estimator',
            ),
          );
          if (state.measurement > budget.availablePromptTokens) {
            throw new ContextBudgetExceededError(
              state.measurement,
              budget.availablePromptTokens,
              'conservative_estimate',
            );
          }
        }
        safetyEstimate = {
          version: 1,
          source: 'local',
          accuracy: 'conservative',
          purpose: 'overflow_protection',
          provider: budget.provider,
          model: budget.model,
          estimatorId: this.safetyEstimator.id,
          estimatedPromptTokens: state.measurement,
          calculatedAt: createdAt,
          displayable: false,
        };
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
    const contextSnapshot = buildContextSnapshot({
      runId: input.runId,
      sessionId: input.sessionId,
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
      exactCounterId: counterResolution.counter?.id,
      unavailableCounterReason: counterFailure
        ? `Exact token counter ${counterResolution.counter?.id ?? 'unknown'} failed: ${counterFailure}`
        : counterResolution.reason,
    });
    const modelRequestSnapshot = buildModelRequestSnapshot({
      runId: input.runId,
      sessionId: input.sessionId,
      stage: input.stage,
      requestIndex: input.requestIndex,
      provider: budget.provider,
      model: budget.model,
      createdAt,
      request: state.request,
      contextSnapshotId: contextSnapshot.id,
      callContract: input.callContract,
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
