// Safe, deterministic application of runtime TaskBook patches.
//
// A patch is a narrow host-validated mutation. It is never a replacement for
// DECIDE: completed, in-progress, failed, blocked, and skipped steps remain
// protected evidence, while only pending work may be edited or removed.

import type {
  PlanStep,
  RunContext,
  TaskBook,
  TaskBookPatch,
  TaskBookPatchOperation,
  TaskStepStatus,
} from '@littlesheep/types';
import { TASK_BOOK_PATCH_VERSION } from '@littlesheep/types';

export const MAX_TASK_BOOK_PATCH_OPERATIONS = 16 as const;
export const MAX_TASK_BOOK_PATCH_EVENT_IDS = 32 as const;
export const MAX_TASK_BOOK_PATCH_STEPS = 64 as const;
export const MAX_TASK_BOOK_PATCH_TOOLS = 32 as const;
export const MAX_TASK_BOOK_PATCH_CRITERIA = 32 as const;
export const MAX_TASK_BOOK_PATCH_TEXT = 8_192 as const;
export const MAX_APPLIED_TASK_BOOK_PATCH_IDS = 64 as const;

const PROTECTED_STEP_STATUSES: ReadonlySet<TaskStepStatus> = new Set([
  'in_progress',
  'done',
  'blocked',
  'failed',
  'skipped',
]);
const STEP_KEYS = new Set([
  'id',
  'title',
  'description',
  'tools',
  'requiresApproval',
  'acceptanceCriteria',
  'expectedOutput',
  'status',
]);
const UPDATE_KEYS = new Set([
  'title',
  'description',
  'tools',
  'requiresApproval',
  'acceptanceCriteria',
  'expectedOutput',
]);

export type TaskBookPatchRejectReason =
  | 'invalid-patch'
  | 'run-mismatch'
  | 'revision-conflict'
  | 'event-mismatch'
  | 'operation-limit'
  | 'step-limit'
  | 'protected-step'
  | 'duplicate-step'
  | 'unknown-step'
  | 'invalid-operation'
  | 'no-taskbook';

export type TaskBookPatchApplyResult =
  | { kind: 'applied'; taskBook: TaskBook; revision: number; patchId: string }
  | { kind: 'duplicate'; taskBook: TaskBook; revision: number; patchId: string }
  | { kind: 'rejected'; reason: TaskBookPatchRejectReason; message: string; patchId?: string };

export interface TaskBookPatchApplyOptions {
  runId: string;
  currentRevision: number;
  claimedEventIds?: readonly string[];
  appliedPatchIds?: readonly string[];
}

/**
 * Apply one untrusted patch to a cloned TaskBook. The input is `unknown` on
 * purpose: event payloads cross a process boundary and TypeScript types do not
 * validate JSON at runtime.
 */
export function applyTaskBookPatch(
  current: TaskBook,
  input: unknown,
  options: TaskBookPatchApplyOptions,
): TaskBookPatchApplyResult {
  const parsed = validatePatch(input, options);
  if (!parsed.ok) return rejectedResult(parsed);
  const patch = parsed.patch;

  if (options.appliedPatchIds?.includes(patch.id)) {
    return {
      kind: 'duplicate',
      taskBook: cloneTaskBook(current),
      revision: options.currentRevision,
      patchId: patch.id,
    };
  }
  if (patch.baseRevision !== options.currentRevision || patch.nextRevision !== patch.baseRevision + 1) {
    return {
      kind: 'rejected',
      reason: 'revision-conflict',
      message: `TaskBook revision conflict: expected base ${options.currentRevision}, received ${patch.baseRevision}.`,
      patchId: patch.id,
    };
  }

  const normalized = normalizeCurrentSteps(current);
  if (!normalized.ok) return rejectedResult(normalized);
  const steps = normalized.steps;
  const operatedStepIds = new Set<string>();

  for (const operation of patch.operations) {
    const result = applyOperation(steps, operation, operatedStepIds);
    if (!result.ok) return rejectedResult(result, patch.id);
  }
  if (steps.length === 0) {
    return {
      kind: 'rejected',
      reason: 'step-limit',
      message: 'A TaskBook must retain at least one step.',
      patchId: patch.id,
    };
  }
  if (steps.length > MAX_TASK_BOOK_PATCH_STEPS) {
    return {
      kind: 'rejected',
      reason: 'step-limit',
      message: `TaskBook cannot contain more than ${MAX_TASK_BOOK_PATCH_STEPS} steps.`,
      patchId: patch.id,
    };
  }

  const next = cloneTaskBook(current);
  next.steps = steps;
  for (const operation of patch.operations) {
    if (operation.type === 'replace_success_criteria') next.successCriteria = [...operation.successCriteria];
    if (operation.type === 'update_goal') {
      next.goal = operation.goal;
      next.assessment = { ...next.assessment, goal: operation.goal };
    }
  }
  if (next.stageResults) {
    const retained = new Set(steps.map((step) => step.id));
    next.stageResults = next.stageResults
      .filter((result) => retained.has(result.stepId))
      .map((result) => ({ ...result, toolResults: [...result.toolResults], toolCallIds: [...result.toolCallIds] }));
  }
  return {
    kind: 'applied',
    taskBook: next,
    revision: patch.nextRevision,
    patchId: patch.id,
  };
}

/** Apply and record a patch on the mutable run context at a safe boundary. */
export function applyTaskBookPatchToContext(
  ctx: RunContext,
  input: unknown,
  claimedEventIds?: readonly string[],
): TaskBookPatchApplyResult {
  if (!ctx.taskBook) {
    return { kind: 'rejected', reason: 'no-taskbook', message: 'No TaskBook exists at this runtime boundary.' };
  }
  const result = applyTaskBookPatch(ctx.taskBook, input, {
    runId: ctx.runId,
    currentRevision: ctx.taskBookRevision ?? 1,
    claimedEventIds,
    appliedPatchIds: ctx.appliedTaskBookPatchIds,
  });
  if (result.kind === 'applied') {
    ctx.taskBook = result.taskBook;
    ctx.plan = result.taskBook.steps;
    ctx.taskBookRevision = result.revision;
    ctx.appliedTaskBookPatchIds = [
      ...(ctx.appliedTaskBookPatchIds ?? []),
      result.patchId,
    ].slice(-MAX_APPLIED_TASK_BOOK_PATCH_IDS);
  }
  return result;
}

function validatePatch(
  input: unknown,
  options: TaskBookPatchApplyOptions,
): { ok: true; patch: TaskBookPatch } | { ok: false; reason: TaskBookPatchRejectReason; message: string; patchId?: string } {
  if (!isRecord(input)) return reject('invalid-patch', 'TaskBook patch must be an object.');
  const patchId = boundedId(input.id);
  if (input.version !== TASK_BOOK_PATCH_VERSION) return reject('invalid-patch', 'Unsupported TaskBook patch version.', patchId);
  const runId = boundedId(input.runId);
  if (!runId || runId !== options.runId) return reject('run-mismatch', 'TaskBook patch belongs to another run.', patchId);
  if (!patchId) return reject('invalid-patch', 'TaskBook patch id must be a non-empty bounded string.');
  if (!Number.isSafeInteger(input.baseRevision) || (input.baseRevision as number) < 0
    || !Number.isSafeInteger(input.nextRevision) || (input.nextRevision as number) < 1) {
    return reject('invalid-patch', 'TaskBook patch revisions must be non-negative safe integers.', patchId);
  }
  const eventIds = boundedStringArray(input.eventIds, MAX_TASK_BOOK_PATCH_EVENT_IDS);
  if (!eventIds.ok || eventIds.values.length === 0) return reject('invalid-patch', 'TaskBook patch eventIds are invalid.', patchId);
  if (options.claimedEventIds && !eventIds.values.every((id) => options.claimedEventIds!.includes(id))) {
    return reject('event-mismatch', 'TaskBook patch references an event outside the claimed decision batch.', patchId);
  }
  const reason = boundedText(input.reason, MAX_TASK_BOOK_PATCH_TEXT);
  if (!reason) return reject('invalid-patch', 'TaskBook patch reason must be non-empty and bounded.', patchId);
  const createdAt = normalizeTimestamp(input.createdAt);
  if (!createdAt) return reject('invalid-patch', 'TaskBook patch createdAt must be a valid timestamp.', patchId);
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > MAX_TASK_BOOK_PATCH_OPERATIONS) {
    return reject('operation-limit', `TaskBook patch must contain 1-${MAX_TASK_BOOK_PATCH_OPERATIONS} operations.`, patchId);
  }
  const operations: TaskBookPatchOperation[] = [];
  for (const raw of input.operations) {
    const operation = validateOperation(raw);
    if (!operation.ok) return reject(operation.reason, operation.message, patchId);
    operations.push(operation.operation);
  }
  return {
    ok: true,
    patch: {
      version: TASK_BOOK_PATCH_VERSION,
      id: patchId,
      runId,
      baseRevision: input.baseRevision as number,
      nextRevision: input.nextRevision as number,
      eventIds: eventIds.values,
      reason,
      operations,
      createdAt,
    },
  };
}

function validateOperation(
  value: unknown,
): { ok: true; operation: TaskBookPatchOperation } | { ok: false; reason: TaskBookPatchRejectReason; message: string } {
  if (!isRecord(value) || typeof value.type !== 'string') return reject('invalid-operation', 'TaskBook patch operation is invalid.');
  if (value.type === 'add_step') {
    if (!isRecord(value.step)) return reject('invalid-operation', 'add_step requires a step object.');
    const step = validateStep(value.step, true);
    if (!step.ok) return step;
    const afterStepId = value.afterStepId === undefined ? undefined : boundedId(value.afterStepId);
    if (value.afterStepId !== undefined && !afterStepId) return reject('invalid-operation', 'add_step.afterStepId is invalid.');
    return { ok: true, operation: { type: 'add_step', ...(afterStepId ? { afterStepId } : {}), step: step.step } };
  }
  if (value.type === 'update_pending_step') {
    const stepId = boundedId(value.stepId);
    if (!stepId || !isRecord(value.patch)) return reject('invalid-operation', 'update_pending_step target or patch is invalid.');
    for (const key of Object.keys(value.patch)) {
      if (!UPDATE_KEYS.has(key)) return reject('invalid-operation', `update_pending_step cannot change '${key}'.`);
    }
    if (Object.keys(value.patch).length === 0) return reject('invalid-operation', 'update_pending_step patch cannot be empty.');
    const patch: Partial<Omit<PlanStep, 'id' | 'status'>> = {};
    if ('title' in value.patch) patch.title = optionalText(value.patch.title);
    if ('description' in value.patch) patch.description = boundedText(value.patch.description, MAX_TASK_BOOK_PATCH_TEXT);
    if ('tools' in value.patch) {
      const tools = boundedStringArray(value.patch.tools, MAX_TASK_BOOK_PATCH_TOOLS);
      if (!tools.ok) return reject('invalid-operation', 'Step tools are invalid.');
      patch.tools = tools.values;
    }
    if ('requiresApproval' in value.patch) {
      if (typeof value.patch.requiresApproval !== 'boolean') return reject('invalid-operation', 'requiresApproval must be boolean.');
      patch.requiresApproval = value.patch.requiresApproval;
    }
    if ('acceptanceCriteria' in value.patch) {
      const criteria = boundedStringArray(value.patch.acceptanceCriteria, MAX_TASK_BOOK_PATCH_CRITERIA, MAX_TASK_BOOK_PATCH_TEXT);
      if (!criteria.ok) return reject('invalid-operation', 'acceptanceCriteria are invalid.');
      patch.acceptanceCriteria = criteria.values;
    }
    if ('expectedOutput' in value.patch) patch.expectedOutput = optionalText(value.patch.expectedOutput);
    return { ok: true, operation: { type: 'update_pending_step', stepId, patch } };
  }
  if (value.type === 'remove_pending_step') {
    const stepId = boundedId(value.stepId);
    return stepId
      ? { ok: true, operation: { type: 'remove_pending_step', stepId } }
      : reject('invalid-operation', 'remove_pending_step target is invalid.');
  }
  if (value.type === 'replace_success_criteria') {
    const criteria = boundedStringArray(value.successCriteria, MAX_TASK_BOOK_PATCH_CRITERIA, MAX_TASK_BOOK_PATCH_TEXT);
    return criteria.ok
      ? { ok: true, operation: { type: 'replace_success_criteria', successCriteria: criteria.values } }
      : reject('invalid-operation', 'successCriteria are invalid.');
  }
  if (value.type === 'update_goal') {
    const goal = boundedText(value.goal, MAX_TASK_BOOK_PATCH_TEXT);
    return goal
      ? { ok: true, operation: { type: 'update_goal', goal } }
      : reject('invalid-operation', 'update_goal goal is invalid.');
  }
  return reject('invalid-operation', `Unsupported TaskBook patch operation: ${value.type}.`);
}

function validateStep(
  value: Record<string, unknown>,
  requireId: boolean,
): { ok: true; step: PlanStep } | { ok: false; reason: TaskBookPatchRejectReason; message: string } {
  for (const key of Object.keys(value)) {
    if (!STEP_KEYS.has(key)) return reject('invalid-operation', `Step contains unsupported field '${key}'.`);
  }
  const id = value.id === undefined ? undefined : boundedId(value.id);
  if (requireId && !id) return reject('invalid-operation', 'Added steps require a stable id.');
  const description = boundedText(value.description, MAX_TASK_BOOK_PATCH_TEXT);
  if (!description) return reject('invalid-operation', 'Step description must be non-empty.');
  const title = value.title === undefined ? undefined : optionalText(value.title);
  const tools = value.tools === undefined ? undefined : boundedStringArray(value.tools, MAX_TASK_BOOK_PATCH_TOOLS);
  if (tools && !tools.ok) return reject('invalid-operation', 'Step tools are invalid.');
  const criteria = value.acceptanceCriteria === undefined
    ? undefined
    : boundedStringArray(value.acceptanceCriteria, MAX_TASK_BOOK_PATCH_CRITERIA, MAX_TASK_BOOK_PATCH_TEXT);
  if (criteria && !criteria.ok) return reject('invalid-operation', 'Step acceptanceCriteria are invalid.');
  if (value.requiresApproval !== undefined && typeof value.requiresApproval !== 'boolean') return reject('invalid-operation', 'requiresApproval must be boolean.');
  const status = value.status === undefined ? 'pending' : value.status;
  if (status !== 'pending') return reject('protected-step', 'New steps must start as pending.');
  return {
    ok: true,
    step: {
      ...(id ? { id } : {}),
      ...(title ? { title } : {}),
      description,
      ...(tools && tools.ok ? { tools: tools.values } : {}),
      ...(value.requiresApproval === undefined ? {} : { requiresApproval: value.requiresApproval }),
      ...(criteria && criteria.ok ? { acceptanceCriteria: criteria.values } : {}),
      ...(value.expectedOutput === undefined ? {} : { expectedOutput: optionalText(value.expectedOutput) }),
      status: 'pending',
    },
  };
}

function normalizeCurrentSteps(
  taskBook: TaskBook,
): { ok: true; steps: PlanStep[] } | { ok: false; reason: TaskBookPatchRejectReason; message: string } {
  if (!Array.isArray(taskBook.steps) || taskBook.steps.length < 1 || taskBook.steps.length > MAX_TASK_BOOK_PATCH_STEPS) {
    return reject('step-limit', `Current TaskBook must contain 1-${MAX_TASK_BOOK_PATCH_STEPS} steps.`);
  }
  const ids = new Set<string>();
  const steps: PlanStep[] = [];
  for (const [index, raw] of taskBook.steps.entries()) {
    const step = cloneJson(raw);
    const id = boundedId(step.id) || `step-${index + 1}`;
    if (ids.has(id)) return reject('duplicate-step', `Current TaskBook contains duplicate step id '${id}'.`);
    ids.add(id);
    step.id = id;
    step.status ??= 'pending';
    steps.push(step);
  }
  return { ok: true, steps };
}

function applyOperation(
  steps: PlanStep[],
  operation: TaskBookPatchOperation,
  operatedStepIds: Set<string>,
): { ok: true } | { ok: false; reason: TaskBookPatchRejectReason; message: string } {
  if (operation.type === 'add_step') {
    if (steps.some((step) => step.id === operation.step.id)) return reject('duplicate-step', `Step id '${operation.step.id}' already exists.`);
    if (steps.length >= MAX_TASK_BOOK_PATCH_STEPS) return reject('step-limit', `TaskBook cannot contain more than ${MAX_TASK_BOOK_PATCH_STEPS} steps.`);
    const index = operation.afterStepId === undefined
      ? steps.length - 1
      : steps.findIndex((step) => step.id === operation.afterStepId);
    if (operation.afterStepId !== undefined && index < 0) return reject('unknown-step', `Step '${operation.afterStepId}' was not found.`);
    steps.splice(index + 1, 0, cloneJson(operation.step));
    return { ok: true };
  }
  if (operation.type === 'replace_success_criteria' || operation.type === 'update_goal') return { ok: true };
  if (operatedStepIds.has(operation.stepId)) return reject('invalid-operation', `Step '${operation.stepId}' is targeted more than once in one patch.`);
  operatedStepIds.add(operation.stepId);
  const index = steps.findIndex((step) => step.id === operation.stepId);
  if (index < 0) return reject('unknown-step', `Step '${operation.stepId}' was not found.`);
  const step = steps[index]!;
  if (PROTECTED_STEP_STATUSES.has(step.status ?? 'pending')) {
    return reject('protected-step', `Step '${operation.stepId}' is already ${step.status} and cannot be changed.`);
  }
  if (operation.type === 'remove_pending_step') {
    if (steps.length <= 1) return reject('step-limit', 'A TaskBook must retain at least one step.');
    steps.splice(index, 1);
    return { ok: true };
  }
  if (operation.type === 'update_pending_step') {
    Object.assign(step, cloneJson(operation.patch));
    step.status = 'pending';
    return { ok: true };
  }
  return reject('invalid-operation', 'Unsupported TaskBook patch operation.');
}

function cloneTaskBook(taskBook: TaskBook): TaskBook {
  return cloneJson(taskBook);
}

function boundedStringArray(
  value: unknown,
  maximum: number,
  itemMaximum = MAX_TASK_BOOK_PATCH_TEXT,
): { ok: true; values: string[] } | { ok: false } {
  if (!Array.isArray(value) || value.length > maximum) return { ok: false };
  const values = value.map((item) => boundedText(item, itemMaximum));
  if (values.some((item) => !item) || new Set(values).size !== values.length) return { ok: false };
  return { ok: true, values };
}

function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : '';
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const normalized = boundedText(value, MAX_TASK_BOOK_PATCH_TEXT);
  return normalized || undefined;
}

function boundedId(value: unknown): string {
  return boundedText(value, 256);
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function reject(
  reason: TaskBookPatchRejectReason,
  message: string,
  patchId?: string,
): { ok: false; reason: TaskBookPatchRejectReason; message: string; patchId?: string } {
  return { ok: false, reason, message, ...(patchId ? { patchId } : {}) };
}

function rejectedResult(
  failure: { ok: false; reason: TaskBookPatchRejectReason; message: string; patchId?: string },
  patchId = failure.patchId,
): TaskBookPatchApplyResult {
  return {
    kind: 'rejected',
    reason: failure.reason,
    message: failure.message,
    ...(patchId ? { patchId } : {}),
  };
}
