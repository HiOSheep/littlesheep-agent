// RCD R4-B evaluation contract V2.
//
// This module is the single runtime authority for the V2 record/ledger shape.
// The companion JSON Schema (docs/reference/rcd-r4b-v2-contract-schema-2026-10-21.json)
// describes the same shape for reviewers; the cross-field invariants that JSON
// Schema cannot express are enforced here and listed in its `x-runtime-invariants`
// array. A test pins the two representations together.
//
// Design rules:
// - Goal / Contract / Mechanism settle independently; no aggregate verdict.
// - Missing evidence can never become a pass.
// - A constraint may only be attributed to the model when it was visible.
// - Legacy (schemaVersion 1) results are display-only and never auto-mapped.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CONTRACT_VERSION = '2.0.0';
export const SCHEMA_VERSION = 2;
export const SUITE_ID = 'LS-RCD-R4B-V2';
export const TRIAL_MIN = 1;
export const TRIAL_MAX = 5;

export const CONTRACT_SCHEMA_PATH = 'docs/reference/rcd-r4b-v2-contract-schema-2026-10-21.json';
export const TASK_SUITE_PATH = 'docs/reference/rcd-r4b-v2-task-suite-2026-10-21.json';

export const DIMENSION_NAMES = Object.freeze(['goal', 'contract', 'mechanism']);
export const GOAL_STATUSES = Object.freeze(['passed', 'failed', 'not_applicable', 'unverified']);
export const CONTRACT_STATUSES = Object.freeze(['passed', 'failed', 'not_applicable', 'unverified']);
export const MECHANISM_STATUSES = Object.freeze(['passed', 'failed', 'not_exercised', 'blocked', 'unverified']);
export const EVIDENCE_TIERS = Object.freeze(['A_runtime_deterministic', 'B_real_model']);
export const INFRASTRUCTURE_STATUSES = Object.freeze(['executed', 'blocked', 'harness_error', 'not_run']);
export const CREDIBILITY_LEVELS = Object.freeze(['direct_evidence', 'partial_evidence', 'insufficient']);

export const REQUIRED_RECORD_FIELDS = Object.freeze([
  'schemaVersion', 'contractVersion', 'recordId', 'batchId', 'taskId', 'taskVersion', 'trial',
  'evidenceTier', 'product', 'evaluator', 'modelConfig', 'userGoal', 'dimensions', 'legacyOracle',
  'providerUsage', 'execution', 'credibility', 'cleanup',
]);
export const REQUIRED_LEDGER_FIELDS = Object.freeze([
  'schemaVersion', 'contractVersion', 'suiteId', 'batchId', 'generatedAt', 'evidenceTier',
  'records', 'metrics', 'legacy',
]);
export const REQUIRED_DIMENSION_FIELDS = Object.freeze(['status', 'evidenceRefs', 'rejectionReasons', 'missingFields']);
export const REQUIRED_MECHANISM_FIELDS = Object.freeze(['status', 'triggered', 'evidenceRefs', 'rejectionReasons', 'missingFields']);

/**
 * Frozen baselines R4-B must not modify. Values were read from the committed
 * files at the R4-B baseline (c12fb52e); the verification test re-hashes them.
 */
export const FROZEN_BASELINES = Object.freeze({
  s3aTaskSuite: { path: 'docs/reference/rcd-s3a-task-suite-2026-10-17.json', sha256: 'b210e505c89a8c795fbae62693295cd2527a50d04c355e6e9c43dd7e54a629ec' },
  s3bMetricsSchema: { path: 'docs/reference/rcd-s3b-metrics-schema-2026-10-17.json', sha256: 'dac05d0595a34f66ed46c8f7620cfa6a2b1ad923f1782629f88324bc4c994b65' },
  s3bAdapterExtension: { path: 'docs/reference/rcd-s3b-adapter-extension-2026-10-17.json', sha256: '8172bacd72be40ac49de357467da5c4c214e23256b6ca686e9bb87af1b8b66e8' },
  s3aEvaluationProtocol: { path: 'docs/reference/rcd-s3a-evaluation-protocol-2026-10-17.md', sha256: 'c84dd79f7394065de43c967a0cdd36640a54d2c66bfc32ed29c0bcd13f6a259c' },
  rcdS0fCoreBaseline: { path: 'docs/reference/rcd-s0f-core-baseline-2026-10-16.json', sha256: '05a4ac6203ead92af49b441fb1c3b3cde23cb24d0d4a10bdc627517276d60084' },
});

/** Evaluator files covered by the V2 evaluator fingerprint. */
export const EVALUATOR_FILES = Object.freeze([
  CONTRACT_SCHEMA_PATH,
  TASK_SUITE_PATH,
  'scripts/lib/r4b/contract.mjs',
  'scripts/lib/r4b/tasks.mjs',
  'scripts/lib/r4b/oracles.mjs',
  'scripts/lib/r4b/ledger.mjs',
  'scripts/lib/r4b/metrics.mjs',
  'scripts/eval-v2.mjs',
]);

/** Workspace paths that are evaluation artifacts, not product source. */
const EVALUATION_ARTIFACT_PATTERNS = Object.freeze([
  /^docs\/reference\/rcd-r4b-/u,
  /^scripts\/lib\/r4b\//u,
  /^scripts\/eval-v2\.mjs$/u,
  /^test\/v2-/u,
  /^test\/fixtures\/r4b\//u,
  /^docs\/reference\/README\.md$/u,
  /^scripts\/README\.md$/u,
  /^package\.json$/u,
]);

export function sha256Text(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function canonicalJson(value) {
  return JSON.stringify(value);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

export function makeRecordId({ batchId, taskId, trial }) {
  if (typeof batchId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,40}$/u.test(batchId)) {
    throw new Error(`Invalid batchId: ${String(batchId)}`);
  }
  if (typeof taskId !== 'string' || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(taskId)) {
    throw new Error(`Invalid taskId: ${String(taskId)}`);
  }
  if (!Number.isSafeInteger(trial) || trial < TRIAL_MIN || trial > TRIAL_MAX) {
    throw new Error(`trial must be an integer from ${TRIAL_MIN} to ${TRIAL_MAX}`);
  }
  return `v2:${batchId}:${taskId}:trial:${trial}`;
}

export function parseRecordId(recordId) {
  if (typeof recordId !== 'string') return null;
  const match = /^v2:([a-z0-9][a-z0-9-]*):([A-Z0-9]+(?:-[A-Z0-9]+)*):trial:([1-5])$/u.exec(recordId);
  if (!match) return null;
  return { batchId: match[1], taskId: match[2], trial: Number(match[3]) };
}

export function computeEvaluatorFingerprint({ repoRoot = REPO_ROOT, files = EVALUATOR_FILES } = {}) {
  const hash = createHash('sha256');
  for (const file of files) {
    const absolute = join(repoRoot, file);
    if (!existsSync(absolute)) throw new Error(`EVALUATOR_FILE_MISSING: ${file}`);
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function gitProductState({ repoRoot = REPO_ROOT } = {}) {
  // Only trailing newlines are stripped: `git status --porcelain` lines begin
  // with a significant status column, and trimming the whole output would eat
  // the leading space of the first ` M path` line (dropping the path's first
  // character and falsely marking product source as dirty).
  const git = (...args) => execFileSync('git', args, {
    cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\r?\n+$/u, '');
  const head = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const statusText = git('status', '--porcelain=v1', '--untracked-files=all');
  const dirtyPaths = statusText.split(/\r?\n/u).filter(Boolean).map((entry) => {
    const raw = entry.slice(3).trim();
    const arrow = raw.lastIndexOf(' -> ');
    return (arrow >= 0 ? raw.slice(arrow + 4) : raw).replaceAll('\\', '/');
  });
  const sourceDirtyPaths = dirtyPaths.filter((path) => !EVALUATION_ARTIFACT_PATTERNS.some((pattern) => pattern.test(path)));
  return {
    sha: head,
    treeFingerprint: sha256Text(tree),
    dirty: dirtyPaths.length > 0,
    sourceDirty: sourceDirtyPaths.length > 0,
    dirtyPaths,
    sourceDirtyPaths,
  };
}

export function verifyFrozenBaselines({ repoRoot = REPO_ROOT } = {}) {
  const checks = Object.entries(FROZEN_BASELINES).map(([key, baseline]) => {
    const absolute = join(repoRoot, baseline.path);
    const actual = existsSync(absolute) ? sha256File(absolute) : null;
    return { key, path: baseline.path, expected: baseline.sha256, actual, ok: actual === baseline.sha256 };
  });
  return { valid: checks.every((check) => check.ok), checks };
}

function fail(errors, code, path, message) {
  errors.push({ code, path, message });
}

function validateDimensions(record, errors, options) {
  const dimensions = record.dimensions;
  if (!isObject(dimensions)) {
    fail(errors, 'dimensions', 'dimensions', 'dimensions must be an object');
    return;
  }
  const extraKeys = Object.keys(dimensions).filter((key) => !DIMENSION_NAMES.includes(key));
  if (extraKeys.length > 0) fail(errors, 'dimension-key', 'dimensions', `unknown dimension keys: ${extraKeys.join(', ')}`);
  for (const name of DIMENSION_NAMES) {
    const dimension = dimensions[name];
    if (!isObject(dimension)) {
      fail(errors, 'dimension', `dimensions.${name}`, 'dimension must be an object');
      continue;
    }
    const required = name === 'mechanism' ? REQUIRED_MECHANISM_FIELDS : REQUIRED_DIMENSION_FIELDS;
    for (const field of required) {
      if (!(field in dimension)) fail(errors, 'dimension-field', `dimensions.${name}.${field}`, `missing ${field}`);
    }
    const statuses = name === 'mechanism' ? MECHANISM_STATUSES : (name === 'goal' ? GOAL_STATUSES : CONTRACT_STATUSES);
    if (!statuses.includes(dimension.status)) {
      fail(errors, 'dimension-status', `dimensions.${name}.status`, `invalid status ${String(dimension.status)}`);
    }
    if (!isStringArray(dimension.evidenceRefs)) fail(errors, 'dimension-evidence', `dimensions.${name}.evidenceRefs`, 'evidenceRefs must be an array of non-empty strings');
    if (!isStringArray(dimension.rejectionReasons)) fail(errors, 'dimension-rejection', `dimensions.${name}.rejectionReasons`, 'rejectionReasons must be an array of non-empty strings');
    if (!isStringArray(dimension.missingFields)) fail(errors, 'dimension-missing', `dimensions.${name}.missingFields`, 'missingFields must be an array of non-empty strings');
    const evidence = Array.isArray(dimension.evidenceRefs) ? dimension.evidenceRefs : [];
    const rejections = Array.isArray(dimension.rejectionReasons) ? dimension.rejectionReasons : [];
    const missing = Array.isArray(dimension.missingFields) ? dimension.missingFields : [];
    if (dimension.status === 'passed') {
      if (evidence.length === 0) fail(errors, 'passed-without-evidence', `dimensions.${name}`, 'passed requires at least one evidence reference');
      if (rejections.length > 0) fail(errors, 'passed-with-rejection', `dimensions.${name}`, 'passed cannot carry rejection reasons');
      if (missing.length > 0) fail(errors, 'passed-with-missing', `dimensions.${name}`, 'passed cannot carry missing fields');
    }
    if (dimension.status === 'failed' && rejections.length === 0) {
      fail(errors, 'failed-without-reason', `dimensions.${name}`, 'failed requires a rejection reason');
    }
    if (dimension.status === 'unverified' && missing.length === 0) {
      fail(errors, 'unverified-without-gap', `dimensions.${name}`, 'unverified requires at least one missing field');
    }
    if (name === 'contract' && (dimension.status === 'passed' || dimension.status === 'failed')) {
      if (dimension.constraintVisible !== true) fail(errors, 'contract-not-visible', 'dimensions.contract.constraintVisible', 'contract settlement requires the constraint to be visible to the model');
      if (!isNonEmptyString(dimension.constraintRef)) fail(errors, 'contract-ref', 'dimensions.contract.constraintRef', 'contract settlement requires a constraintRef');
    }
    if (name === 'mechanism') {
      if (typeof dimension.triggered !== 'boolean') fail(errors, 'mechanism-triggered', 'dimensions.mechanism.triggered', 'triggered must be a boolean');
      if (dimension.status === 'not_exercised' && dimension.triggered !== false) fail(errors, 'mechanism-not-exercised-triggered', 'dimensions.mechanism', 'not_exercised requires triggered=false');
      if (['passed', 'failed', 'blocked'].includes(dimension.status) && dimension.triggered !== true) {
        fail(errors, 'mechanism-status-triggered', 'dimensions.mechanism', `${dimension.status} requires triggered=true`);
      }
      if (dimension.status === 'blocked' && !isNonEmptyString(dimension.blockReason)) {
        fail(errors, 'mechanism-blocked-reason', 'dimensions.mechanism.blockReason', 'blocked requires a blockReason');
      }
    }
  }
  // Task-suite consistency: contract visibility and applicability.
  const task = options?.task ?? null;
  if (task) {
    const contractDimension = dimensions.contract;
    if (task.contract === null || task.contract === undefined) {
      if (contractDimension && contractDimension.status !== 'not_applicable') {
        fail(errors, 'contract-not-applicable', 'dimensions.contract.status', `${record.taskId} defines no explicit contract; contract must be not_applicable`);
      }
    } else if (contractDimension && contractDimension.status === 'not_applicable') {
      fail(errors, 'contract-applicable', 'dimensions.contract.status', `${record.taskId} defines an explicit contract; contract cannot be not_applicable`);
    }
    if (contractDimension && isNonEmptyString(task.contractRef) && contractDimension.constraintRef
      && contractDimension.constraintRef !== task.contractRef) {
      fail(errors, 'contract-ref-mismatch', 'dimensions.contract.constraintRef', `constraintRef must be ${task.contractRef}`);
    }
    if (record.taskVersion !== task.version) {
      fail(errors, 'task-version', 'taskVersion', `taskVersion must be ${task.version} for ${record.taskId}`);
    }
  }
}

export function validateEvaluationRecord(record, options = {}) {
  const errors = [];
  if (!isObject(record)) {
    fail(errors, 'record-type', '$', 'record must be an object');
    return { valid: false, errors };
  }
  for (const field of REQUIRED_RECORD_FIELDS) {
    if (!(field in record)) fail(errors, 'record-field', field, `missing required field ${field}`);
  }
  for (const forbidden of ['status', 'result', 'overallStatus', 'overall']) {
    if (forbidden in record) fail(errors, 'aggregate-verdict', forbidden, 'records must not carry an aggregate verdict across dimensions');
  }
  if (record.schemaVersion !== SCHEMA_VERSION) fail(errors, 'schema-version', 'schemaVersion', `schemaVersion must be ${SCHEMA_VERSION}`);
  if (record.contractVersion !== CONTRACT_VERSION) fail(errors, 'contract-version', 'contractVersion', `contractVersion must be ${CONTRACT_VERSION}`);
  const parsed = parseRecordId(record.recordId);
  if (!parsed) {
    fail(errors, 'record-id', 'recordId', 'recordId must match v2:<batchId>:<taskId>:trial:<1..5>');
  } else {
    if (record.batchId !== parsed.batchId) fail(errors, 'record-id-batch', 'recordId', 'recordId batchId does not match batchId');
    if (record.taskId !== parsed.taskId) fail(errors, 'record-id-task', 'recordId', 'recordId taskId does not match taskId');
    if (record.trial !== parsed.trial) fail(errors, 'record-id-trial', 'recordId', 'recordId trial does not match trial');
  }
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/u.test(record.batchId ?? '')) fail(errors, 'batch-id', 'batchId', 'invalid batchId');
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(record.taskId ?? '')) fail(errors, 'task-id', 'taskId', 'invalid taskId');
  if (!/^\d+\.\d+\.\d+$/u.test(record.taskVersion ?? '')) fail(errors, 'task-version', 'taskVersion', 'taskVersion must be semver-like');
  if (!EVIDENCE_TIERS.includes(record.evidenceTier)) fail(errors, 'evidence-tier', 'evidenceTier', 'invalid evidenceTier');
  if (!isNonNegativeInteger(record.trial) || record.trial < TRIAL_MIN || record.trial > TRIAL_MAX) {
    fail(errors, 'trial', 'trial', `trial must be ${TRIAL_MIN}..${TRIAL_MAX}`);
  }
  if (record.ancestry !== null && record.ancestry !== undefined) {
    if (!isObject(record.ancestry) || !isNonEmptyString(record.ancestry.taskId)
      || !['goal_only', 'contract_extension', 'recovery_mechanism', 'same_goal'].includes(record.ancestry.relation)) {
      fail(errors, 'ancestry', 'ancestry', 'ancestry must name a legacy taskId and a known relation');
    }
  }
  const product = record.product;
  if (!isObject(product) || !/^[0-9a-f]{7,40}$/u.test(product.sha ?? '') || !isNonEmptyString(product.treeFingerprint)
    || typeof product.dirty !== 'boolean' || typeof product.sourceDirty !== 'boolean' || !Array.isArray(product.dirtyPaths)) {
    fail(errors, 'product', 'product', 'product must carry sha, treeFingerprint, dirty, sourceDirty and dirtyPaths');
  }
  const evaluator = record.evaluator;
  if (!isObject(evaluator) || !/^[0-9a-f]{64}$/u.test(evaluator.fingerprint ?? '')
    || !/^[0-9a-f]{64}$/u.test(evaluator.contractSha256 ?? '') || !/^[0-9a-f]{64}$/u.test(evaluator.taskSuiteSha256 ?? '')) {
    fail(errors, 'evaluator', 'evaluator', 'evaluator must carry fingerprint/contractSha256/taskSuiteSha256 as sha256');
  } else if (options.expectedFingerprint && evaluator.fingerprint !== options.expectedFingerprint) {
    fail(errors, 'evaluator-fingerprint', 'evaluator.fingerprint', 'evaluator fingerprint does not match the frozen V2 fingerprint');
  }
  const modelConfig = record.modelConfig;
  if (!isObject(modelConfig) || !isNonEmptyString(modelConfig.providerId) || typeof modelConfig.simulated !== 'boolean') {
    fail(errors, 'model-config', 'modelConfig', 'modelConfig must carry providerId and simulated');
  }
  const userGoal = record.userGoal;
  if (!isObject(userGoal) || !isNonEmptyString(userGoal.text) || !isNonEmptyString(userGoal.constraintVersion)) {
    fail(errors, 'user-goal', 'userGoal', 'userGoal must carry text and constraintVersion');
  } else if (userGoal.textSha256 !== sha256Text(userGoal.text)) {
    fail(errors, 'user-goal-hash', 'userGoal.textSha256', 'userGoal.textSha256 does not match the goal text');
  }
  validateDimensions(record, errors, options);
  if (record.legacyOracle !== null && record.legacyOracle !== undefined) {
    if (!isObject(record.legacyOracle)) {
      fail(errors, 'legacy-oracle', 'legacyOracle', 'legacyOracle must be null or an object');
    } else if (record.legacyOracle.legacyMapped !== false) {
      fail(errors, 'legacy-mapped', 'legacyOracle.legacyMapped', 'legacy results must not be auto-mapped to V2 dimensions');
    }
  }
  const usage = record.providerUsage;
  if (!isObject(usage) || !['available', 'partial', 'unavailable'].includes(usage.status)) {
    fail(errors, 'provider-usage', 'providerUsage', 'providerUsage.status must be available/partial/unavailable');
  } else {
    const tokens = [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens];
    if (usage.status === 'unavailable') {
      if (tokens.some((value) => value !== null && value !== undefined)) fail(errors, 'usage-unavailable-values', 'providerUsage', 'unavailable usage must be null, never zero or inferred');
      if (!isNonEmptyString(usage.reason)) fail(errors, 'usage-unavailable-reason', 'providerUsage.reason', 'unavailable usage requires a reason');
    } else {
      if (!isNonNegativeInteger(usage.inputTokens) || !isNonNegativeInteger(usage.outputTokens)) {
        fail(errors, 'usage-values', 'providerUsage', 'available/partial usage requires observed input and output tokens');
      }
    }
  }
  const execution = record.execution;
  if (!isObject(execution)) {
    fail(errors, 'execution', 'execution', 'execution must be an object');
  } else {
    if (!INFRASTRUCTURE_STATUSES.includes(execution.infrastructureStatus)) fail(errors, 'infrastructure', 'execution.infrastructureStatus', 'invalid infrastructureStatus');
    if (!isNonNegativeInteger(execution.durationMs)) fail(errors, 'duration', 'execution.durationMs', 'durationMs must be a non-negative number');
    if (!isNonEmptyString(execution.startedAt) || !isNonEmptyString(execution.endedAt)) fail(errors, 'timestamps', 'execution', 'startedAt/endedAt are required');
    const requests = execution.requests;
    if (!isObject(requests) || !['logical', 'physical', 'retries', 'blocked', 'budget'].every((key) => isNonNegativeInteger(requests[key]))) {
      fail(errors, 'requests', 'execution.requests', 'requests must carry non-negative logical/physical/retries/blocked/budget');
    } else if (requests.physical > requests.budget) {
      fail(errors, 'budget-exceeded', 'execution.requests.physical', 'physical requests must not exceed the recorded budget');
    }
    const tokens = execution.tokens;
    if (!isObject(tokens) || !['requestedMax', 'effectiveMax', 'observedInput', 'observedOutput'].every((key) => tokens[key] === null || tokens[key] === undefined || isNonNegativeInteger(tokens[key]))) {
      fail(errors, 'token-budget', 'execution.tokens', 'token budget fields must be null or non-negative integers');
    }
    const tooling = execution.tooling;
    if (!isObject(tooling) || !['proposals', 'executed', 'denied', 'failed'].every((key) => tooling[key] === null || tooling[key] === undefined || isNonNegativeInteger(tooling[key]))) {
      fail(errors, 'tooling', 'execution.tooling', 'tool counts must be null or non-negative integers');
    }
    const effects = execution.effects;
    if (!isObject(effects) || !isNonNegativeInteger(effects.duplicateSuccessful)) {
      fail(errors, 'effects', 'execution.effects', 'effects.duplicateSuccessful must be a non-negative integer');
    }
  }
  const safety = record.safety;
  if (safety !== undefined) {
    if (!isObject(safety) || !['denied', 'loopback_only', 'provider_only'].includes(safety.networkPolicy)
      || safety.credentialsRedacted !== true) {
      fail(errors, 'safety', 'safety', 'safety must declare a network policy with redacted credentials');
    }
  }
  const credibility = record.credibility;
  if (!isObject(credibility) || !CREDIBILITY_LEVELS.includes(credibility.level) || !isStringArray(credibility.missingFields)) {
    fail(errors, 'credibility', 'credibility', 'credibility must carry a level and missingFields');
  }
  const cleanup = record.cleanup;
  if (!isObject(cleanup) || typeof cleanup.attempted !== 'boolean' || typeof cleanup.succeeded !== 'boolean' || !Array.isArray(cleanup.residuals)) {
    fail(errors, 'cleanup', 'cleanup', 'cleanup must carry attempted/succeeded/residuals');
  }
  // Cross-dimension invariants.
  const dimensions = record.dimensions ?? {};
  const infra = execution?.infrastructureStatus;
  const cleanupSucceeded = cleanup?.succeeded === true;
  if (cleanup && cleanup.succeeded === false) {
    if (infra !== 'harness_error') fail(errors, 'cleanup-infrastructure', 'execution.infrastructureStatus', 'cleanup failure must force harness_error');
    for (const name of DIMENSION_NAMES) {
      const status = dimensions[name]?.status;
      if (status === 'passed' || status === 'failed') {
        fail(errors, 'cleanup-claim', `dimensions.${name}.status`, 'a failed cleanup cannot settle a dimension as passed/failed');
      }
    }
  }
  if (infra !== undefined && infra !== 'executed') {
    for (const name of ['goal', 'contract']) {
      const status = dimensions[name]?.status;
      if (status === 'passed' || status === 'failed') {
        fail(errors, 'infrastructure-claim', `dimensions.${name}.status`, `${infra} cannot settle ${name} as passed/failed; harness problems must not become task or model failures`);
      }
    }
  }
  if (effectsPassed(record) && execution?.effects?.duplicateSuccessful > 0) {
    fail(errors, 'duplicate-effects', 'execution.effects.duplicateSuccessful', 'mechanism cannot pass when a successful effect was duplicated');
  }
  if (safety && isNonNegativeInteger(safety.forbiddenRequests) && safety.forbiddenRequests > 0
    && (dimensions.goal?.status === 'passed' || dimensions.contract?.status === 'passed')) {
    fail(errors, 'forbidden-request', 'safety.forbiddenRequests', 'a security-boundary violation cannot settle a dimension as passed');
  }
  if (options.expectedTier && record.evidenceTier !== options.expectedTier) {
    fail(errors, 'evidence-tier-mismatch', 'evidenceTier', `expected tier ${options.expectedTier}`);
  }
  return { valid: errors.length === 0, errors };
}

function effectsPassed(record) {
  return record.dimensions?.mechanism?.status === 'passed';
}

export function assertEvaluationRecord(record, options = {}) {
  const result = validateEvaluationRecord(record, options);
  if (!result.valid) {
    const error = new Error(`Invalid V2 evaluation record: ${result.errors.map((item) => `${item.code}@${item.path}`).join(', ')}`);
    error.code = 'EVALUATION_RECORD_INVALID';
    error.errors = result.errors;
    throw error;
  }
  return result;
}

export function validateLedger(ledger, options = {}) {
  const errors = [];
  if (!isObject(ledger)) {
    fail(errors, 'ledger-type', '$', 'ledger must be an object');
    return { valid: false, errors };
  }
  for (const field of REQUIRED_LEDGER_FIELDS) {
    if (!(field in ledger)) fail(errors, 'ledger-field', field, `missing required field ${field}`);
  }
  if (ledger.schemaVersion !== SCHEMA_VERSION) fail(errors, 'ledger-schema', 'schemaVersion', `schemaVersion must be ${SCHEMA_VERSION}`);
  if (ledger.contractVersion !== CONTRACT_VERSION) fail(errors, 'ledger-contract', 'contractVersion', `contractVersion must be ${CONTRACT_VERSION}`);
  if (ledger.suiteId !== SUITE_ID) fail(errors, 'ledger-suite', 'suiteId', `suiteId must be ${SUITE_ID}`);
  if (!isNonEmptyString(ledger.batchId) || !isNonEmptyString(ledger.generatedAt)) fail(errors, 'ledger-batch', 'batchId', 'batchId/generatedAt are required');
  if (!EVIDENCE_TIERS.includes(ledger.evidenceTier)) fail(errors, 'ledger-tier', 'evidenceTier', 'invalid evidenceTier');
  if (!Array.isArray(ledger.records)) {
    fail(errors, 'ledger-records', 'records', 'records must be an array');
  } else {
    if (ledger.records.length === 0) fail(errors, 'ledger-empty', 'records', 'ledger must contain at least one record');
    const seen = new Set();
    const tasks = options.tasks ?? [];
    for (const [index, record] of ledger.records.entries()) {
      const task = tasks.find((entry) => entry.id === record?.taskId) ?? null;
      const result = validateEvaluationRecord(record, { ...options, task, expectedTier: ledger.evidenceTier });
      for (const error of result.errors) fail(errors, error.code, `records[${index}].${error.path}`, error.message);
      if (record?.evidenceTier && record.evidenceTier !== ledger.evidenceTier) {
        fail(errors, 'ledger-tier-mixed', `records[${index}].evidenceTier`, 'a ledger must not mix controlled and real-model samples');
      }
      const key = `${record?.taskId}:${record?.trial}`;
      if (seen.has(key)) fail(errors, 'ledger-duplicate', `records[${index}]`, `duplicate taskId/trial record ${key}`);
      seen.add(key);
      if (record?.batchId !== ledger.batchId) fail(errors, 'ledger-batch-record', `records[${index}].batchId`, 'record batchId does not match the ledger');
    }
  }
  const metrics = ledger.metrics;
  if (!isObject(metrics) || !['goal', 'contract', 'mechanism'].every((name) => isObject(metrics[name])) || !isObject(metrics.perTask)) {
    fail(errors, 'metrics', 'metrics', 'metrics must carry goal/contract/mechanism and perTask');
  } else {
    for (const name of ['goal', 'contract', 'mechanism']) {
      const metric = metrics[name];
      if (!isNonEmptyString(metric.denominatorId) || !isNonNegativeInteger(metric.n)
        || !isNonNegativeInteger(metric.passed) || !isNonNegativeInteger(metric.failed)) {
        fail(errors, 'metric-shape', `metrics.${name}`, 'metric must carry denominatorId/n/passed/failed');
        continue;
      }
      if (metric.n !== metric.passed + metric.failed) fail(errors, 'metric-n', `metrics.${name}.n`, 'n must equal passed + failed');
      if (metric.populationClaim !== false) fail(errors, 'metric-population', `metrics.${name}.populationClaim`, 'populationClaim must be false');
      if (!isObject(metric.excluded)) fail(errors, 'metric-excluded', `metrics.${name}.excluded`, 'excluded must be an object');
    }
    if (options.computeMetrics) {
      const expected = options.computeMetrics(ledger.records);
      for (const name of ['goal', 'contract', 'mechanism']) {
        const actual = metrics[name];
        const wanted = expected[name];
        if (actual.n !== wanted.n || actual.passed !== wanted.passed || actual.failed !== wanted.failed) {
          fail(errors, 'metric-mismatch', `metrics.${name}`, 'reported metrics do not match the computed record counts');
        }
      }
    }
  }
  const legacy = ledger.legacy;
  if (!isObject(legacy) || !Array.isArray(legacy.records) || legacy.mappedToDimensions !== false || !isNonEmptyString(legacy.denominatorId)) {
    fail(errors, 'legacy-section', 'legacy', 'legacy section must be display-only (mappedToDimensions=false) with its own denominatorId');
  }
  return { valid: errors.length === 0, errors };
}

export function assertLedger(ledger, options = {}) {
  const result = validateLedger(ledger, options);
  if (!result.valid) {
    const error = new Error(`Invalid V2 evaluation ledger: ${result.errors.map((item) => `${item.code}@${item.path}`).join(', ')}`);
    error.code = 'EVALUATION_LEDGER_INVALID';
    error.errors = result.errors;
    throw error;
  }
  return result;
}

/**
 * Read a legacy (schemaVersion 1) record file as display-only data. Supports the
 * S3B controlled ledger, the curated real-model batch, and a single trial
 * record. Legacy results are never mapped to V2 dimensions.
 */
export function readLegacyRecords(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const rawRecords = Array.isArray(parsed.records)
    ? parsed.records
    : Array.isArray(parsed.attempts)
      ? parsed.attempts
      : [parsed];
  const records = rawRecords.map((record) => ({
    recordId: record.recordId ?? null,
    taskId: record.taskId ?? null,
    trial: Number.isSafeInteger(record.trial) ? record.trial : null,
    evidenceTier: record.evidenceTier ?? parsed.evidenceTier ?? 'unknown',
    oracleResult: record.oracle?.result ?? record.oracleResult ?? 'unverified',
    oracleVersion: 'legacy-s3b-v1',
    evaluatorFingerprint: record.source?.evaluatorFingerprint ?? record.evaluationFingerprint ?? null,
    productHead: record.source?.productHead ?? record.productHead ?? null,
    logicalModelRequests: record.execution?.logicalModelRequests ?? record.logicalModelRequests ?? null,
    physicalProviderRequests: record.execution?.physicalProviderRequests ?? record.physicalProviderRequests ?? null,
    displayOnly: true,
    mappedToDimensions: false,
  }));
  return {
    schemaVersion: parsed.schemaVersion ?? 1,
    sourcePath: path.replaceAll('\\', '/'),
    records,
    displayOnly: true,
    mappedToDimensions: false,
  };
}
