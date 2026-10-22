// R4-D0 frozen real-model trial protocol.
//
// This module defines the versioned plan and evidence rules only. It never
// calls a Provider and never authorizes a paid run: the real-trial executor
// must be authorized and budget-confirmed by the user first.
import {
  CONTRACT_SCHEMA_PATH,
  DIMENSION_NAMES,
  EVALUATOR_FILES,
  FROZEN_BASELINES,
  REPO_ROOT,
  SUITE_ID,
  TASK_SUITE_PATH,
  TRIAL_MAX,
  TRIAL_MIN,
  canonicalJson,
  computeEvaluatorFingerprint,
  gitProductState,
  makeRecordId,
  sha256File,
  sha256Text,
} from '../r4b/contract.mjs';
import { loadTaskSuite } from '../r4b/tasks.mjs';
import { NON_RETRYABLE_PROVIDER_STATUSES, RETRYABLE_PROVIDER_STATUSES, SUPPORTED_PROVIDER_PROTOCOLS } from '../s3b-provider-config.mjs';

export const R4D0_PROTOCOL_VERSION = '1.0.0';
export const R4D0_BATCH_ID = 'r4d0-offline-rehearsal-2026-10-22';
export const REAL_BATCH_PREFIX = 'r4d0-real-';
export const TASK_IDS = Object.freeze(['FILE-02-G', 'FILE-02-S', 'DELIV-01-G', 'DELIV-01-R']);
export const TRIALS_PER_TASK = 5;
export const PLANNED_TRIAL_COUNT = TASK_IDS.length * TRIALS_PER_TASK;
export const REAL_EVIDENCE_TIER = 'B_real_model';

export const BUDGETS = Object.freeze({
  maxPhysicalRequestsPerTrial: 8,
  maxBatchPhysicalRequests: 160,
  maxOutputTokensPerRequest: 2048,
  maxBatchOutputTokens: 40960,
  maxAttempts: 2,
  maxCostUsd: 5,
  maxCostCny: null,
  providerBillingCapConfirmed: false,
});

export const STOP_CODES = Object.freeze([
  'CONFIG_INVALID',
  'MODEL_MAPPING_INVALID',
  'AUTH_FAILED',
  'MODEL_NOT_FOUND',
  'DETERMINISTIC_4XX',
  'BUDGET_REQUESTS_EXHAUSTED',
  'BUDGET_TOKENS_EXHAUSTED',
  'BUDGET_COST_UNCONFIRMED',
  'DUPLICATE_TRIAL_IDENTITY',
  'LEDGER_WRITE_FAILED',
  'PROVIDER_TRANSIENT_EXHAUSTED',
  'AUTHORIZATION_CHANGED',
  'USAGE_UNAVAILABLE',
  'SAFETY_NETWORK_DENIED',
]);

/** Metric definitions. A status excluded here never enters that metric's denominator. */
export const METRICS = Object.freeze({
  goal: { denominator: ['passed', 'failed'], excluded: ['not_applicable', 'unverified'], populationClaim: false },
  contract: { denominator: ['passed', 'failed'], excluded: ['not_applicable', 'unverified'], populationClaim: false },
  mechanism: { denominator: ['passed', 'failed'], excluded: ['not_exercised', 'blocked', 'unverified'], populationClaim: false },
});

export const MODEL_CONFIG_TEMPLATE = Object.freeze({
  providerId: null,
  internalModelRef: null,
  wireModelId: null,
  apiProtocol: null,
  baseURL: null,
  supportsToolCalls: null,
  temperature: 0,
  maxOutputTokens: 2048,
  timeoutSeconds: 120,
  maxAttempts: 1,
});

export function taskDefinitionSha256(task) {
  return sha256Text(canonicalJson(task));
}

export function trialIdentity({ batchId, taskId, trial }) {
  if (typeof batchId !== 'string' || !batchId.trim()) throw new Error('protocol: batchId is required');
  if (!TASK_IDS.includes(taskId)) throw new Error(`protocol: unknown task ${taskId}`);
  if (!Number.isSafeInteger(trial) || trial < TRIAL_MIN || trial > TRIAL_MAX) {
    throw new Error(`protocol: trial must be an integer ${TRIAL_MIN}..${TRIAL_MAX}`);
  }
  return { batchId: batchId.trim(), taskId, trial, recordId: makeRecordId({ batchId: batchId.trim(), taskId, trial }) };
}

export function buildTrialPlan({ batchId = R4D0_BATCH_ID, taskIds = TASK_IDS, trialsPerTask = TRIALS_PER_TASK } = {}) {
  if (!Number.isSafeInteger(trialsPerTask) || trialsPerTask < 1 || trialsPerTask > TRIAL_MAX) {
    throw new Error(`protocol: trialsPerTask must be 1..${TRIAL_MAX}`);
  }
  const plan = [];
  for (const taskId of taskIds) {
    for (let trial = TRIAL_MIN; trial <= trialsPerTask; trial += 1) plan.push(trialIdentity({ batchId, taskId, trial }));
  }
  const validation = validateTrialPlan(plan);
  if (!validation.ok) throw new Error(`protocol: invalid plan: ${validation.errors.join('; ')}`);
  return plan;
}

export function validateTrialPlan(plan, { expectedBatchId } = {}) {
  const errors = [];
  const seen = new Set();
  if (!Array.isArray(plan)) return { ok: false, errors: ['plan must be an array'] };
  for (const item of plan) {
    const key = `${item?.batchId}\0${item?.taskId}\0${item?.trial}`;
    if (!item?.batchId || !TASK_IDS.includes(item.taskId) || !Number.isSafeInteger(item.trial)
      || item.trial < TRIAL_MIN || item.trial > TRIAL_MAX) {
      errors.push(`invalid identity: ${JSON.stringify(item)}`);
      continue;
    }
    if (item.recordId !== makeRecordId({ batchId: item.batchId, taskId: item.taskId, trial: item.trial })) {
      errors.push(`recordId does not match identity: ${item.recordId}`);
    }
    if (seen.has(key)) errors.push(`duplicate trial identity: ${item.taskId} trial ${item.trial}`);
    seen.add(key);
    if (expectedBatchId && item.batchId !== expectedBatchId) errors.push(`unexpected batchId: ${item.batchId}`);
  }
  for (const taskId of TASK_IDS) {
    for (let trial = TRIAL_MIN; trial <= TRIAL_MAX; trial += 1) {
      if (!seen.has(`${expectedBatchId ?? plan[0]?.batchId}\0${taskId}\0${trial}`)) {
        errors.push(`missing planned trial: ${taskId} trial ${trial}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateModelConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return { ok: false, errors: ['model config must be an object'] };
  for (const key of ['providerId', 'internalModelRef', 'wireModelId', 'apiProtocol', 'baseURL', 'supportsToolCalls']) {
    if (!config[key]) errors.push(`${key} is required`);
  }
  if (config.apiProtocol && !SUPPORTED_PROVIDER_PROTOCOLS.includes(config.apiProtocol)) {
    errors.push(`unsupported apiProtocol: ${config.apiProtocol}`);
  }
  if (config.supportsToolCalls !== true) errors.push('supportsToolCalls must be explicitly true for the V2 tasks');
  if (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 || config.maxOutputTokens > BUDGETS.maxOutputTokensPerRequest) {
    errors.push(`maxOutputTokens must be 1..${BUDGETS.maxOutputTokensPerRequest}`);
  }
  if (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > BUDGETS.maxAttempts) {
    errors.push(`maxAttempts must be 1..${BUDGETS.maxAttempts}`);
  }
  if (config.baseURL && !/^https:\/\//iu.test(config.baseURL)) errors.push('baseURL must be HTTPS');
  return { ok: errors.length === 0, errors };
}

/** Classify one attempt without ever reading the model's reply as evidence. */
export function classifyAttempt({ infrastructureStatus, dimensions, errorCode } = {}) {
  if (errorCode && STOP_CODES.includes(errorCode)) return { category: 'stopped', stopCode: errorCode };
  if (infrastructureStatus === 'harness_error' || infrastructureStatus === 'blocked' || infrastructureStatus === 'not_run') {
    return { category: 'infrastructure', stopCode: null };
  }
  if (infrastructureStatus !== 'executed') return { category: 'infrastructure', stopCode: null };
  const statuses = DIMENSION_NAMES.map((name) => dimensions?.[name]?.status);
  if (statuses.includes('failed')) return { category: 'capability_failure', stopCode: null };
  if (statuses.some((status) => status === 'unverified' || status === 'blocked')) {
    return { category: 'capability_unresolved', stopCode: null };
  }
  // passed / not_applicable / not_exercised are all neutral-or-positive for an attempt.
  return { category: 'capability_pass', stopCode: null };
}

export function evaluateTrialBudget({ physicalRequests = 0, outputTokens = 0, batchPhysicalRequests = 0, batchOutputTokens = 0, budgets = BUDGETS } = {}) {
  if (physicalRequests > budgets.maxPhysicalRequestsPerTrial) return { stop: true, code: 'BUDGET_REQUESTS_EXHAUSTED', reason: 'per-trial physical request budget exceeded' };
  if (outputTokens > budgets.maxOutputTokensPerRequest) return { stop: true, code: 'BUDGET_TOKENS_EXHAUSTED', reason: 'per-trial output token budget exceeded' };
  if (batchPhysicalRequests > budgets.maxBatchPhysicalRequests) return { stop: true, code: 'BUDGET_REQUESTS_EXHAUSTED', reason: 'batch physical request budget exceeded' };
  if (batchOutputTokens > budgets.maxBatchOutputTokens) return { stop: true, code: 'BUDGET_TOKENS_EXHAUSTED', reason: 'batch output token budget exceeded' };
  return { stop: false, code: null, reason: null };
}

export function buildProtocolFrozen({ repoRoot = REPO_ROOT, generatedAt = new Date().toISOString() } = {}) {
  const loaded = loadTaskSuite();
  const tasks = loaded.tasks.map((task) => ({
    id: task.id,
    version: task.version,
    definitionSha256: taskDefinitionSha256(task),
    userInputSha256: sha256Text(task.userInput),
    seedSha256: sha256Text(canonicalJson(task.seed)),
    permissionPreset: task.permissionPreset,
    allowedTools: task.allowedTools,
    dimensions: task.dimensions,
  }));
  return {
    protocolVersion: R4D0_PROTOCOL_VERSION,
    generatedAt,
    status: 'frozen-for-authorization',
    mayCallRealProvider: false,
    suiteId: SUITE_ID,
    evidenceTierForRealTrials: REAL_EVIDENCE_TIER,
    product: gitProductState({ repoRoot }),
    evaluator: { fingerprint: computeEvaluatorFingerprint({ repoRoot }), files: EVALUATOR_FILES },
    hashes: {
      taskSuite: sha256File(`${repoRoot}/${TASK_SUITE_PATH}`),
      contractSchema: sha256File(`${repoRoot}/${CONTRACT_SCHEMA_PATH}`),
      taskModule: sha256File(`${repoRoot}/scripts/lib/r4b/tasks.mjs`),
      oracleModule: sha256File(`${repoRoot}/scripts/lib/r4b/oracles.mjs`),
      evalV2: sha256File(`${repoRoot}/scripts/eval-v2.mjs`),
      v2Adapter: sha256File(`${repoRoot}/test/v2-task-adapters.test.ts`),
      providerConfig: sha256File(`${repoRoot}/scripts/lib/s3b-provider-config.mjs`),
      frozen: FROZEN_BASELINES,
    },
    tasks,
    plan: buildTrialPlan(),
    plannedTrials: PLANNED_TRIAL_COUNT,
    budgets: BUDGETS,
    stopCodes: STOP_CODES,
    metrics: METRICS,
    providerPolicy: {
      protocols: SUPPORTED_PROVIDER_PROTOCOLS,
      nonRetryableStatuses: NON_RETRYABLE_PROVIDER_STATUSES,
      retryableStatuses: RETRYABLE_PROVIDER_STATUSES,
      usageWhenMissing: 'unavailable',
      costCapRequiresProviderSideConfirmation: true,
      localRequestAndTokenLimitsAreNotCostCaps: true,
      credentials: 'redacted; never persisted in records or logs',
      network: 'denied for controlled evaluation; real trials require explicit authorization',
    },
    separation: {
      s3bHistoricalRealTrials: 'LS-RCD-S3B historical four-task real trials; different oracle/contract, display-only, never combined with V2 rates',
      r4bV2Tasks: 'FILE-02-G/S and DELIV-01-G/R with goal/contract/mechanism dimensions',
      r4cDeliveryRegression: 'DELIV-02 false-completion presentation regression in real Electron; not a model task score',
    },
    authorization: {
      realProviderAuthorized: false,
      requiredUserApproval: ['provider', 'wire model', 'batch/trial scope', 'physical request budget', 'output token budget', 'provider-side cost cap', 'currency amount'],
    },
  };
}
