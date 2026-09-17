// Bounded compatibility codec for persisted bounded-loop to TaskBook promotion.

import type { RunCheckpointResumeState } from '@littlesheep/types';
import { RunCheckpointValidationError } from './run-checkpoint-errors.js';

const MAX_ID_LENGTH = 256;
const REASON_CODES = new Set([
  'dependency_discovered', 'scope_expanded', 'acceptance_gap', 'long_running', 'budget_pressure',
]);

export function validateWorkPolicyUpgradeRequest(
  value: unknown,
): NonNullable<RunCheckpointResumeState['workPolicyUpgradeRequest']> {
  if (!isRecord(value) || value.version !== 1) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.workPolicyUpgradeRequest is invalid.');
  }
  if (typeof value.reasonCode !== 'string' || !REASON_CODES.has(value.reasonCode)) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.workPolicyUpgradeRequest.reasonCode is invalid.');
  }
  const reason = boundedText(value.reason, 1_024, 'checkpoint.resumeState.workPolicyUpgradeRequest.reason');
  return {
    version: 1,
    id: boundedText(value.id, MAX_ID_LENGTH, 'checkpoint.resumeState.workPolicyUpgradeRequest.id'),
    runId: boundedText(value.runId, MAX_ID_LENGTH, 'checkpoint.resumeState.workPolicyUpgradeRequest.runId'),
    sourceMessageId: boundedText(value.sourceMessageId, MAX_ID_LENGTH, 'checkpoint.resumeState.workPolicyUpgradeRequest.sourceMessageId'),
    goalVersion: boundedSafeInteger(value.goalVersion, 'checkpoint.resumeState.workPolicyUpgradeRequest.goalVersion', 1),
    requestedAt: normalizeTimestamp(value.requestedAt, 'checkpoint.resumeState.workPolicyUpgradeRequest.requestedAt'),
    reasonCode: value.reasonCode as NonNullable<RunCheckpointResumeState['workPolicyUpgradeRequest']>['reasonCode'],
    reason,
    // Older version-1 checkpoints used reason as the only remaining-work text.
    remainingGoal: value.remainingGoal === undefined
      ? reason
      : boundedText(value.remainingGoal, 2_000, 'checkpoint.resumeState.workPolicyUpgradeRequest.remainingGoal'),
    completedToolCallIds: boundedStringArray(value.completedToolCallIds, 128, 'checkpoint.resumeState.workPolicyUpgradeRequest.completedToolCallIds'),
    pendingToolCallIds: value.pendingToolCallIds === undefined
      ? []
      : boundedStringArray(value.pendingToolCallIds, 128, 'checkpoint.resumeState.workPolicyUpgradeRequest.pendingToolCallIds'),
    completedEffectRefs: value.completedEffectRefs === undefined
      ? []
      : validateCompletedEffectRefs(value.completedEffectRefs),
    modelAttemptsUsed: boundedSafeInteger(value.modelAttemptsUsed, 'checkpoint.resumeState.workPolicyUpgradeRequest.modelAttemptsUsed', 0),
    budget: value.budget === undefined
      ? { maxModelAttempts: 0, toolLoopIterationsUsed: 0, maxToolLoopIterations: 20, noProgressRounds: 0 }
      : validateUpgradeBudget(value.budget),
  };
}

function validateCompletedEffectRefs(
  value: unknown,
): NonNullable<RunCheckpointResumeState['workPolicyUpgradeRequest']>['completedEffectRefs'] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.workPolicyUpgradeRequest.completedEffectRefs exceeds its limit.');
  }
  return value.map((item, index) => {
    if (!isRecord(item) || (item.status !== 'succeeded' && item.status !== 'failed' && item.status !== 'cancelled')) {
      throw new RunCheckpointValidationError(`checkpoint.resumeState.workPolicyUpgradeRequest.completedEffectRefs[${index}] is invalid.`);
    }
    return {
      idempotencyKey: boundedText(item.idempotencyKey, MAX_ID_LENGTH, `checkpoint.resumeState.workPolicyUpgradeRequest.completedEffectRefs[${index}].idempotencyKey`),
      status: item.status,
      ...(item.callId === undefined ? {} : {
        callId: boundedText(item.callId, MAX_ID_LENGTH, `checkpoint.resumeState.workPolicyUpgradeRequest.completedEffectRefs[${index}].callId`),
      }),
    };
  });
}

function validateUpgradeBudget(
  value: unknown,
): NonNullable<RunCheckpointResumeState['workPolicyUpgradeRequest']>['budget'] {
  if (!isRecord(value)) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.workPolicyUpgradeRequest.budget is invalid.');
  }
  return {
    maxModelAttempts: boundedSafeInteger(value.maxModelAttempts, 'checkpoint.resumeState.workPolicyUpgradeRequest.budget.maxModelAttempts', 0),
    toolLoopIterationsUsed: boundedSafeInteger(value.toolLoopIterationsUsed, 'checkpoint.resumeState.workPolicyUpgradeRequest.budget.toolLoopIterationsUsed', 0),
    maxToolLoopIterations: boundedSafeInteger(value.maxToolLoopIterations, 'checkpoint.resumeState.workPolicyUpgradeRequest.budget.maxToolLoopIterations', 0),
    noProgressRounds: boundedSafeInteger(value.noProgressRounds, 'checkpoint.resumeState.workPolicyUpgradeRequest.budget.noProgressRounds', 0),
  };
}

function boundedStringArray(value: unknown, maximum: number, field: string): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RunCheckpointValidationError(`${field} is missing or exceeds its limit.`);
  }
  const values = value.map((item) => boundedText(item, MAX_ID_LENGTH, field));
  if (new Set(values).size !== values.length) throw new RunCheckpointValidationError(`${field} contains duplicates.`);
  return values;
}

function boundedText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string') throw new RunCheckpointValidationError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new RunCheckpointValidationError(`${field} is empty or too long.`);
  return normalized;
}

function boundedSafeInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RunCheckpointValidationError(`${field} must be a safe integer >= ${minimum}.`);
  }
  return value as number;
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new RunCheckpointValidationError(`${field} must be a valid timestamp.`);
  }
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
