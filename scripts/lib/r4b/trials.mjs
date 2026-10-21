// Trial identity and workspace isolation for R4-B V2.
//
// Identity is (batchId, taskId, trial) with trial 1..5. Every trial owns a
// freshly created mkdtemp root; the record file name is derived from the
// identity so a second run cannot silently overwrite the first one.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TRIAL_MAX, TRIAL_MIN, makeRecordId } from './contract.mjs';

export const DEFAULT_BATCH_ID = 'r4b-offline-2026-10-21';
const BATCH_PATTERN = /^[a-z0-9][a-z0-9-]{2,40}$/u;
const TASK_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;

export function validateTrialIdentity({ batchId = DEFAULT_BATCH_ID, taskId, trial }) {
  const errors = [];
  if (typeof batchId !== 'string' || !BATCH_PATTERN.test(batchId)) errors.push({ code: 'trial-batch', message: `invalid batchId: ${String(batchId)}` });
  if (typeof taskId !== 'string' || !TASK_PATTERN.test(taskId)) errors.push({ code: 'trial-task', message: `invalid taskId: ${String(taskId)}` });
  if (!Number.isSafeInteger(trial) || trial < TRIAL_MIN || trial > TRIAL_MAX) {
    errors.push({ code: 'trial-number', message: `trial must be an integer from ${TRIAL_MIN} to ${TRIAL_MAX}` });
  }
  return { valid: errors.length === 0, errors };
}

export function assertTrialIdentity(input) {
  const result = validateTrialIdentity(input);
  if (!result.valid) {
    const error = new Error(`Invalid V2 trial identity: ${result.errors.map((item) => item.code).join(', ')}`);
    error.code = 'V2_TRIAL_INVALID';
    error.errors = result.errors;
    throw error;
  }
  return result;
}

export function recordFileName(recordId) {
  return `${recordId.replaceAll(':', '__')}.json`;
}

/**
 * Create an isolated trial context. `baseRoot` may be supplied by tests; the
 * default is the system temp directory. The workspace and runtime-data
 * directories are created inside the unique root.
 */
export function createTrial({ batchId = DEFAULT_BATCH_ID, taskId, trial, baseRoot = tmpdir() }) {
  assertTrialIdentity({ batchId, taskId, trial });
  const root = mkdtempSync(join(resolve(baseRoot), `ls-v2-${taskId.toLowerCase()}-t${trial}-`));
  const workspaceDir = join(root, 'workspace');
  const dataDir = join(root, 'runtime-data');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const recordId = makeRecordId({ batchId, taskId, trial });
  return {
    batchId,
    taskId,
    trial,
    recordId,
    fileName: recordFileName(recordId),
    root,
    workspaceDir,
    dataDir,
    identity: { batchId, taskId, trial },
  };
}
