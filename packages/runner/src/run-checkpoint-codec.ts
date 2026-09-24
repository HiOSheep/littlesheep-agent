// Bounded schema, serialization and naming for runtime checkpoints.
//
// Split out of `run-checkpoint-store.ts`: the store owns files, capacity and
// retention, while this module owns what a checkpoint is, which parts of a stored
// value are trusted, and what its file is called. Nothing here touches the disk.

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN } from '@littlesheep/context';
import type { RunCheckpoint, RunCheckpointResumeState, SessionId, StageName } from '@littlesheep/types';
import { RUN_CHECKPOINT_VERSION, sanitizeWebEvidenceProjection } from '@littlesheep/types';
import { RunCheckpointValidationError } from './run-checkpoint-errors.js';
import { validateWorkPolicyUpgradeRequest } from './run-checkpoint-work-policy-codec.js';

const MAX_ID_LENGTH = 256;
const MAX_REASON_LENGTH = 4_096;
const MAX_ACTIVE_STEP_IDS = 4;
const MAX_PENDING_EVENT_IDS = 128;
// New writes use the same 64-entry observation window as Context/model logs.
// Reads retain the older 128-entry limit so pre-5M checkpoints remain inspectable.
export const MAX_PERSISTED_CONTEXT_SNAPSHOT_IDS = MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN;
export const MAX_LEGACY_CONTEXT_SNAPSHOT_IDS = 128;
const MAX_SIDE_EFFECTS = 256;
const MAX_SIDE_EFFECT_RESOURCE_KEYS = 32;
const MAX_RESUME_TOOL_NAMES = 256;
const MAX_RESUME_ATTACHMENTS = 256;
const MAX_RESUME_TOOL_RECIPES = 8;
const MAX_RESUME_EVENTS = 32;
const MAX_RESUME_PATCH_IDS = 128;
const MAX_RESUME_VERIFICATION = 32;

const STAGE_NAMES: ReadonlySet<StageName> = new Set([
  'enter', 'classify', 'reply', 'ask_user', 'decide', 'execute',
  'recover', 'verify', 'evolve', 'capture', 'finalize',
]);
const CHECKPOINT_STATUSES: ReadonlySet<RunCheckpoint['status']> = new Set([
  'paused',
  'waiting_user',
  'recoverable',
]);

export function validateCheckpoint(value: unknown, maxFileBytes: number, maxContextSnapshotIds: number): RunCheckpoint {
  if (!isRecord(value)) throw new RunCheckpointValidationError('Checkpoint must be an object.');
  if (value.version !== RUN_CHECKPOINT_VERSION) {
    throw new RunCheckpointValidationError(`Unsupported run checkpoint version: ${String(value.version)}.`);
  }
  const id = normalizeId(value.id, 'checkpoint.id');
  const runId = normalizeId(value.runId, 'checkpoint.runId');
  const sessionId = normalizeId(value.sessionId, 'checkpoint.sessionId') as SessionId;
  if (!CHECKPOINT_STATUSES.has(value.status as RunCheckpoint['status'])) {
    throw new RunCheckpointValidationError(`Invalid checkpoint status: ${String(value.status)}.`);
  }
  if (typeof value.currentStage !== 'string' || !STAGE_NAMES.has(value.currentStage as StageName)) {
    throw new RunCheckpointValidationError(`Invalid checkpoint stage: ${String(value.currentStage)}.`);
  }
  const taskBookRevision = boundedSafeInteger(value.taskBookRevision, 'checkpoint.taskBookRevision', 0);
  const eventCursor = boundedSafeInteger(value.eventCursor, 'checkpoint.eventCursor', 0);
  const pendingEventIds = boundedStringArray(value.pendingEventIds, MAX_PENDING_EVENT_IDS, 'checkpoint.pendingEventIds');
  const contextSnapshotIds = boundedStringArray(value.contextSnapshotIds, maxContextSnapshotIds, 'checkpoint.contextSnapshotIds');
  const sideEffects = Array.isArray(value.sideEffects) ? value.sideEffects : null;
  if (!sideEffects || sideEffects.length > MAX_SIDE_EFFECTS) {
    throw new RunCheckpointValidationError('checkpoint.sideEffects is missing or exceeds its limit.');
  }
  const normalizedSideEffects = sideEffects.map((effect, index) => validateSideEffect(effect, index));
  if (!isRecord(value.loopBudget)) throw new RunCheckpointValidationError('checkpoint.loopBudget is required.');
  const loopBudget = validateLoopBudget(value.loopBudget);
  const createdAt = normalizeTimestamp(value.createdAt, 'checkpoint.createdAt');
  const reason = boundedText(value.reason, MAX_REASON_LENGTH, 'checkpoint.reason');
  const currentStepId = value.currentStepId === undefined
    ? undefined
    : boundedText(value.currentStepId, MAX_ID_LENGTH, 'checkpoint.currentStepId');
  const activeStepIds = value.activeStepIds === undefined
    ? []
    : boundedStringArray(value.activeStepIds, MAX_ACTIVE_STEP_IDS, 'checkpoint.activeStepIds');
  const resumeState = value.resumeState === undefined
    ? undefined
    : validateResumeState(value.resumeState);
  const webEvidence = sanitizeWebEvidenceProjection(value.webEvidence);
  const checkpoint: RunCheckpoint = {
    version: RUN_CHECKPOINT_VERSION,
    id,
    runId,
    sessionId,
    status: value.status as RunCheckpoint['status'],
    currentStage: value.currentStage as StageName,
    ...(currentStepId ? { currentStepId } : {}),
    ...(activeStepIds.length > 0 ? { activeStepIds } : {}),
    ...(value.taskBook === undefined ? {} : { taskBook: cloneJson(value.taskBook) as RunCheckpoint['taskBook'] }),
    taskBookRevision,
    ...(value.taskExecution === undefined ? {} : { taskExecution: cloneJson(value.taskExecution) as RunCheckpoint['taskExecution'] }),
    eventCursor,
    pendingEventIds,
    ...(value.runtimeEventQueue === undefined ? {} : { runtimeEventQueue: cloneJson(value.runtimeEventQueue) as RunCheckpoint['runtimeEventQueue'] }),
    ...(value.runtimeControl === undefined ? {} : { runtimeControl: cloneJson(value.runtimeControl) as RunCheckpoint['runtimeControl'] }),
    contextSnapshotIds,
    sideEffects: normalizedSideEffects,
    loopBudget,
    ...(webEvidence ? { webEvidence } : {}),
    ...(resumeState ? { resumeState } : {}),
    createdAt,
    reason,
  };
  const serialized = stableSerialize(checkpoint);
  if (Buffer.byteLength(serialized, 'utf8') > maxFileBytes) {
    throw new RunCheckpointValidationError(`Checkpoint exceeds the ${maxFileBytes}-byte limit.`);
  }
  return checkpoint;
}

function validateSideEffect(value: unknown, index: number): RunCheckpoint['sideEffects'][number] {
  if (!isRecord(value)) throw new RunCheckpointValidationError(`checkpoint.sideEffects[${index}] must be an object.`);
  const idempotencyKey = boundedText(value.idempotencyKey, 512, `checkpoint.sideEffects[${index}].idempotencyKey`);
  const toolName = boundedText(value.toolName, MAX_ID_LENGTH, `checkpoint.sideEffects[${index}].toolName`);
  const status = value.status;
  if (status !== 'planned' && status !== 'in_progress' && status !== 'succeeded'
    && status !== 'failed' && status !== 'cancelled' && status !== 'unknown') {
    throw new RunCheckpointValidationError(`checkpoint.sideEffects[${index}].status is invalid.`);
  }
  const output: RunCheckpoint['sideEffects'][number] = { idempotencyKey, toolName, status };
  for (const field of ['inputHash', 'stepId', 'callId', 'ownerId', 'evidenceRef', 'error'] as const) {
    if (value[field] !== undefined) output[field] = boundedText(value[field], field === 'error' ? 2_048 : 512, `checkpoint.sideEffects[${index}].${field}`);
  }
  if (value.effectKind !== undefined) {
    if (value.effectKind !== 'local_mutation' && value.effectKind !== 'external' && value.effectKind !== 'unknown') {
      throw new RunCheckpointValidationError(`checkpoint.sideEffects[${index}].effectKind is invalid.`);
    }
    output.effectKind = value.effectKind;
  }
  if (value.resourceKeys !== undefined) {
    output.resourceKeys = boundedStringArray(value.resourceKeys, MAX_SIDE_EFFECT_RESOURCE_KEYS, `checkpoint.sideEffects[${index}].resourceKeys`);
  }
  for (const field of ['startedAt', 'endedAt'] as const) {
    if (value[field] !== undefined) output[field] = normalizeTimestamp(value[field], `checkpoint.sideEffects[${index}].${field}`);
  }
  if (value.leaseUntil !== undefined) {
    output.leaseUntil = normalizeTimestamp(value.leaseUntil, `checkpoint.sideEffects[${index}].leaseUntil`);
  }
  return output;
}

function validateResumeState(value: unknown): RunCheckpointResumeState {
  if (!isRecord(value) || value.version !== 1) {
    throw new RunCheckpointValidationError('checkpoint.resumeState has an unsupported version.');
  }
  const origin = value.origin;
  if (origin !== 'app' && origin !== 'channel' && origin !== 'cli' && origin !== 'test') {
    throw new RunCheckpointValidationError('checkpoint.resumeState.origin is invalid.');
  }
  const permissionPolicyId = value.permissionPolicyId;
  if (permissionPolicyId !== 'full' && permissionPolicyId !== 'research' && permissionPolicyId !== 'restricted') {
    throw new RunCheckpointValidationError('checkpoint.resumeState.permissionPolicyId is invalid.');
  }
  const reasoning = value.reasoning;
  if (reasoning !== 'auto' && reasoning !== 'low' && reasoning !== 'medium' && reasoning !== 'high' && reasoning !== 'ultra') {
    throw new RunCheckpointValidationError('checkpoint.resumeState.reasoning is invalid.');
  }
  const attachmentCount = boundedSafeInteger(value.attachmentCount, 'checkpoint.resumeState.attachmentCount', 0);
  if (attachmentCount > MAX_RESUME_ATTACHMENTS) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.attachmentCount exceeds its limit.');
  }
  const attachments = value.attachments === undefined
    ? undefined
    : validateResumeAttachments(value.attachments);
  const toolRecipes = value.toolRecipes === undefined
    ? undefined
    : validateToolRecipes(value.toolRecipes);
  const continuation = value.continuation === undefined
    ? undefined
    : validateContinuation(value.continuation);
  const lastError = value.lastError === undefined
    ? undefined
    : validateResumeLastError(value.lastError);
  const workPolicyUpgradeRequest = value.workPolicyUpgradeRequest === undefined
    ? undefined
    : validateWorkPolicyUpgradeRequest(value.workPolicyUpgradeRequest);
  const workspaceContext = value.workspaceContext === undefined
    ? undefined
    : validateWorkspaceContext(value.workspaceContext);
  const availableToolNames = boundedStringArray(value.availableToolNames, MAX_RESUME_TOOL_NAMES, 'checkpoint.resumeState.availableToolNames');
  const appliedTaskBookPatchIds = boundedStringArray(value.appliedTaskBookPatchIds, MAX_RESUME_PATCH_IDS, 'checkpoint.resumeState.appliedTaskBookPatchIds');
  if (!Array.isArray(value.deferredRuntimeEvents) || value.deferredRuntimeEvents.length > MAX_RESUME_EVENTS) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.deferredRuntimeEvents is missing or exceeds its limit.');
  }
  const recoveryAttempts = boundedSafeInteger(value.recoveryAttempts, 'checkpoint.resumeState.recoveryAttempts', 0);
  const replanAttempts = boundedSafeInteger(value.replanAttempts, 'checkpoint.resumeState.replanAttempts', 0);
  const maxReplanAttempts = boundedSafeInteger(value.maxReplanAttempts, 'checkpoint.resumeState.maxReplanAttempts', 0);
  if (!Array.isArray(value.verificationHistory) || value.verificationHistory.length > MAX_RESUME_VERIFICATION) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.verificationHistory is missing or exceeds its limit.');
  }
  return {
    version: 1,
    inboundMessageId: boundedText(value.inboundMessageId, MAX_ID_LENGTH, 'checkpoint.resumeState.inboundMessageId'),
    cwd: boundedText(value.cwd, 4_096, 'checkpoint.resumeState.cwd'),
    ...(workspaceContext ? { workspaceContext } : {}),
    model: boundedText(value.model, 512, 'checkpoint.resumeState.model'),
    origin,
    permissionPolicyId,
    reasoning,
    behaviorModeId: boundedText(value.behaviorModeId, MAX_ID_LENGTH, 'checkpoint.resumeState.behaviorModeId'),
    availableToolNames,
    attachmentCount,
    ...(attachments ? { attachments } : {}),
    ...(toolRecipes ? { toolRecipes } : {}),
    ...(continuation ? { continuation } : {}),
    ...(lastError ? { lastError } : {}),
    ...(value.classification === undefined ? {} : { classification: cloneJson(value.classification) as RunCheckpointResumeState['classification'] }),
    ...(value.needAssessment === undefined ? {} : { needAssessment: cloneJson(value.needAssessment) as RunCheckpointResumeState['needAssessment'] }),
    ...(workPolicyUpgradeRequest ? { workPolicyUpgradeRequest } : {}),
    ...(value.plan === undefined ? {} : { plan: cloneJson(value.plan) as RunCheckpointResumeState['plan'] }),
    appliedTaskBookPatchIds,
    deferredRuntimeEvents: cloneJson(value.deferredRuntimeEvents) as RunCheckpointResumeState['deferredRuntimeEvents'],
    recoveryAttempts,
    replanAttempts,
    maxReplanAttempts,
    verificationHistory: cloneJson(value.verificationHistory) as RunCheckpointResumeState['verificationHistory'],
  };
}

function validateResumeAttachments(value: unknown): NonNullable<RunCheckpointResumeState['attachments']> {
  if (!Array.isArray(value) || value.length > MAX_RESUME_ATTACHMENTS) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.attachments exceeds its limit.');
  }
  const attachments = value.map((item, index) => {
    if (!isRecord(item) || item.version !== 1) {
      throw new RunCheckpointValidationError(`checkpoint.resumeState.attachments[${index}] is invalid.`);
    }
    if (item.kind !== 'image' && item.kind !== 'document' && item.kind !== 'file') {
      throw new RunCheckpointValidationError(`checkpoint.resumeState.attachments[${index}].kind is invalid.`);
    }
    const contentHash = boundedText(
      item.contentHash,
      64,
      `checkpoint.resumeState.attachments[${index}].contentHash`,
    );
    if (!/^[a-f0-9]{64}$/u.test(contentHash)) {
      throw new RunCheckpointValidationError(`checkpoint.resumeState.attachments[${index}].contentHash is invalid.`);
    }
    const size = item.size === undefined
      ? undefined
      : boundedSafeInteger(item.size, `checkpoint.resumeState.attachments[${index}].size`, 0);
    const lineComments = validateCheckpointLineComments(item.lineComments, index);
    return {
      version: 1 as const,
      attachmentId: boundedText(item.attachmentId, MAX_ID_LENGTH, `checkpoint.resumeState.attachments[${index}].attachmentId`),
      cacheId: boundedText(item.cacheId, MAX_ID_LENGTH, `checkpoint.resumeState.attachments[${index}].cacheId`),
      contentHash,
      name: boundedText(item.name, 512, `checkpoint.resumeState.attachments[${index}].name`),
      kind: item.kind as 'image' | 'document' | 'file',
      ...(item.mimeType === undefined ? {} : {
        mimeType: boundedText(item.mimeType, 256, `checkpoint.resumeState.attachments[${index}].mimeType`),
      }),
      ...(size === undefined ? {} : { size }),
      ...(item.contextPath === undefined ? {} : {
        contextPath: boundedText(
          item.contextPath,
          2048,
          `checkpoint.resumeState.attachments[${index}].contextPath`,
        ),
      }),
      ...(lineComments.length === 0 ? {} : { lineComments }),
    };
  });
  const ids = attachments.map((attachment) => attachment.attachmentId);
  if (new Set(ids).size !== ids.length) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.attachments contains duplicate attachment ids.');
  }
  return attachments;
}

function validateCheckpointLineComments(value: unknown, attachmentIndex: number): Array<{
  startLine: number;
  endLine?: number;
  text: string;
}> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new RunCheckpointValidationError(
      `checkpoint.resumeState.attachments[${attachmentIndex}].lineComments is invalid.`,
    );
  }
  return value.map((item, commentIndex) => {
    if (!isRecord(item)) {
      throw new RunCheckpointValidationError(
        `checkpoint.resumeState.attachments[${attachmentIndex}].lineComments[${commentIndex}] is invalid.`,
      );
    }
    const startLine = item.startLine;
    const endLine = item.endLine;
    if (typeof startLine !== 'number'
      || !Number.isSafeInteger(startLine)
      || startLine < 1
      || (endLine !== undefined
        && (typeof endLine !== 'number' || !Number.isSafeInteger(endLine) || endLine < startLine))) {
      throw new RunCheckpointValidationError(
        `checkpoint.resumeState.attachments[${attachmentIndex}].lineComments[${commentIndex}] is invalid.`,
      );
    }
    const text = boundedText(
      item.text,
      4000,
      `checkpoint.resumeState.attachments[${attachmentIndex}].lineComments[${commentIndex}].text`,
    );
    return {
      startLine,
      ...(endLine === undefined ? {} : { endLine }),
      text,
    };
  });
}

function validateToolRecipes(value: unknown): NonNullable<RunCheckpointResumeState['toolRecipes']> {
  if (!Array.isArray(value) || value.length > MAX_RESUME_TOOL_RECIPES) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.toolRecipes exceeds its limit.');
  }
  const recipes = value.map((item, index) => {
    if (!isRecord(item) || item.version !== 1 || item.factory !== 'inspect_attachment') {
      throw new RunCheckpointValidationError(`checkpoint.resumeState.toolRecipes[${index}] is invalid.`);
    }
    return { version: 1 as const, factory: 'inspect_attachment' as const };
  });
  if (new Set(recipes.map((recipe) => recipe.factory)).size !== recipes.length) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.toolRecipes contains duplicates.');
  }
  return recipes;
}

function validateContinuation(value: unknown): NonNullable<RunCheckpointResumeState['continuation']> {
  if (!isRecord(value) || value.version !== 1) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.continuation is invalid.');
  }
  if (value.sourceStage !== 'classify'
    && value.sourceStage !== 'decide'
    && value.sourceStage !== 'execute'
    && value.sourceStage !== 'recover'
    && value.sourceStage !== 'verify') {
    throw new RunCheckpointValidationError('checkpoint.resumeState.continuation.sourceStage is invalid.');
  }
  return {
    version: 1,
    requestId: boundedText(value.requestId, MAX_ID_LENGTH, 'checkpoint.resumeState.continuation.requestId'),
    sourceStage: value.sourceStage,
  };
}

function validateResumeLastError(value: unknown): NonNullable<RunCheckpointResumeState['lastError']> {
  if (!isRecord(value) || typeof value.stage !== 'string' || !STAGE_NAMES.has(value.stage as StageName)) {
    throw new RunCheckpointValidationError('checkpoint.resumeState.lastError is invalid.');
  }
  return {
    stage: value.stage as StageName,
    message: boundedText(value.message, 2_048, 'checkpoint.resumeState.lastError.message'),
  };
}

function validateWorkspaceContext(value: unknown): NonNullable<RunCheckpoint['resumeState']>['workspaceContext'] {
  if (!isRecord(value)) throw new RunCheckpointValidationError('checkpoint.resumeState.workspaceContext must be an object.');
  if (value.boundaryKind !== 'agent_workplace' && value.boundaryKind !== 'user_workplace' && value.boundaryKind !== 'project') {
    throw new RunCheckpointValidationError('checkpoint.resumeState.workspaceContext.boundaryKind is invalid.');
  }
  return {
    boundaryKind: value.boundaryKind,
    ...(value.projectId === undefined ? {} : { projectId: boundedText(value.projectId, MAX_ID_LENGTH, 'checkpoint.resumeState.workspaceContext.projectId') }),
  };
}

function validateLoopBudget(value: Record<string, unknown>): RunCheckpoint['loopBudget'] {
  return {
    attemptsUsed: boundedSafeInteger(value.attemptsUsed, 'loopBudget.attemptsUsed', 0),
    maxAttempts: boundedSafeInteger(value.maxAttempts, 'loopBudget.maxAttempts', 0),
    elapsedMs: boundedSafeInteger(value.elapsedMs, 'loopBudget.elapsedMs', 0),
    maxElapsedMs: boundedSafeInteger(value.maxElapsedMs, 'loopBudget.maxElapsedMs', 0),
    noProgressRounds: boundedSafeInteger(value.noProgressRounds, 'loopBudget.noProgressRounds', 0),
    maxNoProgressRounds: boundedSafeInteger(value.maxNoProgressRounds, 'loopBudget.maxNoProgressRounds', 0),
    ...(value.toolLoopIterationsUsed === undefined ? {} : {
      toolLoopIterationsUsed: boundedSafeInteger(value.toolLoopIterationsUsed, 'loopBudget.toolLoopIterationsUsed', 0),
    }),
    ...(value.maxToolLoopIterations === undefined ? {} : {
      maxToolLoopIterations: boundedSafeInteger(value.maxToolLoopIterations, 'loopBudget.maxToolLoopIterations', 0),
    }),
    ...(value.evidenceFingerprints === undefined ? {} : {
      evidenceFingerprints: boundedStringArray(value.evidenceFingerprints, 128, 'loopBudget.evidenceFingerprints'),
    }),
    ...(value.evidenceFingerprintSaturated === undefined ? {} : {
      evidenceFingerprintSaturated: requiredBoolean(value.evidenceFingerprintSaturated, 'loopBudget.evidenceFingerprintSaturated'),
    }),
    ...(value.costUsed === undefined ? {} : { costUsed: boundedFiniteNumber(value.costUsed, 'loopBudget.costUsed', 0) }),
    ...(value.maxCost === undefined ? {} : { maxCost: boundedFiniteNumber(value.maxCost, 'loopBudget.maxCost', 0) }),
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

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new RunCheckpointValidationError(`${field} must be a boolean.`);
  return value;
}

function boundedText(value: unknown, maximum: number, field: string): string {
  if (typeof value !== 'string') throw new RunCheckpointValidationError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new RunCheckpointValidationError(`${field} is empty or too long.`);
  return normalized;
}

function normalizeId(value: unknown, field: string): string {
  return boundedText(value, MAX_ID_LENGTH, field);
}

function normalizeTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new RunCheckpointValidationError(`${field} must be a valid timestamp.`);
  }
  return new Date(value).toISOString();
}

function boundedSafeInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RunCheckpointValidationError(`${field} must be a safe integer >= ${minimum}.`);
  }
  return value as number;
}

function boundedFiniteNumber(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new RunCheckpointValidationError(`${field} must be a finite number >= ${minimum}.`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export function cloneCheckpoint(value: RunCheckpoint): RunCheckpoint {
  return cloneJson(value);
}

export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function checkpointFileHash(checkpointId: string): string {
  return createHash('sha256').update(checkpointId, 'utf8').digest('hex');
}

export function idFromFileName(file: string): string {
  const name = basename(file);
  return name.endsWith('.json') ? name.slice(0, -5) : name;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
