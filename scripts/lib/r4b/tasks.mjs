// Loader and structural validator for the R4-B V2 task suite.
//
// The suite is versioned and immutable-by-contract: every task carries an
// explicit ancestry hash pointing at the frozen S3A suite. Changing a task's
// text, seed, contract or oracle inputs requires a new taskVersion, and the
// lineage hash proves the frozen S3A file was not rewritten.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CONTRACT_VERSION, FROZEN_BASELINES, REPO_ROOT, SCHEMA_VERSION, SUITE_ID, TASK_SUITE_PATH,
  sha256File, sha256Text,
} from './contract.mjs';

const REQUIRED_TASK_FIELDS = [
  'id', 'version', 'title', 'ancestry', 'userInput', 'seed', 'allowedTools', 'permissionPreset',
  'dimensions', 'goalRules', 'contract', 'faultFixture', 'oracle',
];
const TASK_ID_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(errors, code, path, message) {
  errors.push({ code, path, message });
}

function validateTask(task, index, suite, errors) {
  const path = `tasks[${index}]`;
  if (!isObject(task)) {
    fail(errors, 'task-shape', path, 'task must be an object');
    return;
  }
  for (const field of REQUIRED_TASK_FIELDS) {
    if (!(field in task)) fail(errors, 'task-field', `${path}.${field}`, `missing ${field}`);
  }
  if (!TASK_ID_PATTERN.test(task.id ?? '')) fail(errors, 'task-id', `${path}.id`, 'invalid task id');
  if (!VERSION_PATTERN.test(task.version ?? '')) fail(errors, 'task-version', `${path}.version`, 'task version must be semver-like');
  if (task.dimensions === undefined || !isObject(task.dimensions)) {
    fail(errors, 'task-dimensions', `${path}.dimensions`, 'dimensions must be an object');
  } else {
    for (const name of ['goal', 'contract', 'mechanism']) {
      if (typeof task.dimensions[name] !== 'boolean') fail(errors, 'task-dimensions', `${path}.dimensions.${name}`, 'dimension flags must be booleans');
    }
    if (task.contract !== null && task.dimensions.contract !== true) fail(errors, 'task-contract-flag', `${path}.dimensions.contract`, 'a task with a contract must settle the contract dimension');
    if (task.contract === null && task.dimensions.contract !== false) fail(errors, 'task-contract-flag', `${path}.dimensions.contract`, 'a task without a contract must not settle the contract dimension');
    if (task.faultFixture !== null && task.dimensions.mechanism !== true) fail(errors, 'task-mechanism-flag', `${path}.dimensions.mechanism`, 'a task with a fault fixture must settle the mechanism dimension');
    if (task.faultFixture === null && task.dimensions.mechanism !== false) fail(errors, 'task-mechanism-flag', `${path}.dimensions.mechanism`, 'a task without a fault fixture must not settle the mechanism dimension');
  }
  const ancestry = task.ancestry;
  if (!isObject(ancestry) || typeof ancestry.taskId !== 'string' || typeof ancestry.relation !== 'string') {
    fail(errors, 'task-ancestry', `${path}.ancestry`, 'ancestry must name a frozen taskId and relation');
  } else {
    if (ancestry.frozenTaskSuiteSha256 !== FROZEN_BASELINES.s3aTaskSuite.sha256) {
      fail(errors, 'task-ancestry-hash', `${path}.ancestry.frozenTaskSuiteSha256`, 'ancestry hash must equal the frozen S3A suite hash');
    }
    if (!['goal_only', 'contract_extension', 'recovery_mechanism', 'same_goal'].includes(ancestry.relation)) {
      fail(errors, 'task-ancestry-relation', `${path}.ancestry.relation`, 'unknown ancestry relation');
    }
  }
  if (typeof task.userInput !== 'string' || task.userInput.trim().length === 0) fail(errors, 'task-user-input', `${path}.userInput`, 'userInput is required');
  if (!isObject(task.seed) || Object.values(task.seed).some((value) => typeof value !== 'string')) {
    fail(errors, 'task-seed', `${path}.seed`, 'seed must map relative paths to text fixtures');
  }
  if (!Array.isArray(task.allowedTools) || task.allowedTools.some((tool) => typeof tool !== 'string' || tool.length === 0)) {
    fail(errors, 'task-tools', `${path}.allowedTools`, 'allowedTools must be non-empty strings');
  }
  if (task.permissionPreset !== 'workspace-write') fail(errors, 'task-permission', `${path}.permissionPreset`, 'V2 controlled tasks run with workspace-write');
  if (!isObject(task.goalRules)) {
    fail(errors, 'task-goal-rules', `${path}.goalRules`, 'goalRules are required');
  }
  if (task.contract !== null) {
    if (!isObject(task.contract) || typeof task.contract.ref !== 'string' || task.contract.version !== CONTRACT_VERSION) {
      fail(errors, 'task-contract', `${path}.contract`, 'contract must reference a versioned suite contract');
    } else {
      const contract = suite.contracts?.[task.contract.ref.replace('#/contracts/', '')];
      if (!contract) {
        fail(errors, 'task-contract-missing', `${path}.contract.ref`, `contract ${task.contract.ref} is not defined`);
      } else {
        if (typeof contract.visibleText !== 'string' || contract.visibleText.trim().length === 0) {
          fail(errors, 'task-contract-visible', `${path}.contract.ref`, 'contract must carry the exact visibleText used in the task input');
        } else if (!task.userInput.includes(contract.visibleText)) {
          fail(errors, 'task-contract-not-visible', `${path}.userInput`, 'the contract text must be present in the user input shown to the model');
        }
        if (!isObject(contract.schema)) fail(errors, 'task-contract-schema', `${path}.contract.ref`, 'contract schema is required');
      }
    }
  }
  if (task.faultFixture !== null) {
    if (!isObject(task.faultFixture) || task.faultFixture.kind !== 'evaluator_driven_schema_invalid_first_proposal') {
      fail(errors, 'task-fault-fixture', `${path}.faultFixture`, 'unknown fault fixture kind');
    } else {
      if (!Array.isArray(task.faultFixture.recoveryArgumentNames) || task.faultFixture.recoveryArgumentNames.length === 0) {
        fail(errors, 'task-fault-fixture', `${path}.faultFixture.recoveryArgumentNames`, 'recoveryArgumentNames are required');
      }
      if (!isObject(task.faultFixture.invalidArguments)) fail(errors, 'task-fault-fixture', `${path}.faultFixture.invalidArguments`, 'invalidArguments fixture is required');
    }
  }
  const oracle = task.oracle;
  if (!isObject(oracle) || oracle.module !== 'scripts/lib/r4b/oracles.mjs') {
    fail(errors, 'task-oracle', `${path}.oracle`, 'oracle.module must be scripts/lib/r4b/oracles.mjs');
  } else {
    if (task.dimensions?.goal === true && typeof oracle.goal !== 'string') fail(errors, 'task-oracle-goal', `${path}.oracle.goal`, 'goal oracle function is required');
    if (task.dimensions?.contract === true && typeof oracle.contract !== 'string') fail(errors, 'task-oracle-contract', `${path}.oracle.contract`, 'contract oracle function is required');
    if (task.dimensions?.mechanism === true && typeof oracle.mechanism !== 'string') fail(errors, 'task-oracle-mechanism', `${path}.oracle.mechanism`, 'mechanism oracle function is required');
  }
}

export function validateTaskSuite(suite, { repoRoot = REPO_ROOT } = {}) {
  const errors = [];
  if (!isObject(suite)) {
    fail(errors, 'suite-shape', '$', 'suite must be an object');
    return { valid: false, errors };
  }
  if (suite.schemaVersion !== SCHEMA_VERSION) fail(errors, 'suite-schema', 'schemaVersion', `schemaVersion must be ${SCHEMA_VERSION}`);
  if (suite.contractVersion !== CONTRACT_VERSION) fail(errors, 'suite-contract', 'contractVersion', `contractVersion must be ${CONTRACT_VERSION}`);
  if (suite.suiteId !== SUITE_ID) fail(errors, 'suite-id', 'suiteId', `suiteId must be ${SUITE_ID}`);
  if (suite.evidenceTier !== 'A_runtime_deterministic') fail(errors, 'suite-tier', 'evidenceTier', 'the V2 curated suite is controlled-tier only');
  if (!isObject(suite.frozenAncestry?.s3aTaskSuite)) {
    fail(errors, 'suite-ancestry', 'frozenAncestry.s3aTaskSuite', 'frozen S3A suite ancestry hash is required');
  } else if (suite.frozenAncestry.s3aTaskSuite.sha256 !== FROZEN_BASELINES.s3aTaskSuite.sha256) {
    fail(errors, 'suite-ancestry-hash', 'frozenAncestry.s3aTaskSuite.sha256', 'ancestry hash must equal the frozen S3A suite hash');
  }
  if (!isObject(suite.contracts)) fail(errors, 'suite-contracts', 'contracts', 'contracts must be an object');
  const tasks = Array.isArray(suite.tasks) ? suite.tasks : [];
  if (tasks.length !== 4) fail(errors, 'suite-tasks', 'tasks', `expected four V2 tasks, found ${tasks.length}`);
  const ids = [];
  for (const [index, task] of tasks.entries()) {
    validateTask(task, index, suite, errors);
    if (task?.id) ids.push(task.id);
  }
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) fail(errors, 'suite-duplicate', 'tasks', `duplicate task ids: ${duplicates.join(', ')}`);
  const expectedIds = ['FILE-02-G', 'FILE-02-S', 'DELIV-01-G', 'DELIV-01-R'];
  for (const id of expectedIds) if (!ids.includes(id)) fail(errors, 'suite-missing-task', 'tasks', `missing task ${id}`);
  for (const id of ids) if (!expectedIds.includes(id)) fail(errors, 'suite-unknown-task', 'tasks', `unknown task ${id}`);
  return { valid: errors.length === 0, errors };
}

export function assertTaskSuite(suite, options) {
  const result = validateTaskSuite(suite, options);
  if (!result.valid) {
    const error = new Error(`Invalid V2 task suite: ${result.errors.map((item) => `${item.code}@${item.path}`).join(', ')}`);
    error.code = 'V2_TASK_SUITE_INVALID';
    error.errors = result.errors;
    throw error;
  }
  return result;
}

export function loadTaskSuite({ repoRoot = REPO_ROOT } = {}) {
  const absolute = join(repoRoot, TASK_SUITE_PATH);
  const raw = readFileSync(absolute, 'utf8');
  const suite = JSON.parse(raw);
  assertTaskSuite(suite, { repoRoot });
  const tasks = suite.tasks.map((task) => ({
    ...task,
    taskDefinitionSha256: sha256Text(JSON.stringify(task)),
  }));
  return {
    suite,
    tasks,
    contracts: suite.contracts,
    suiteSha256: sha256File(absolute),
    path: TASK_SUITE_PATH,
  };
}

export function taskById(loaded, taskId) {
  const task = loaded.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`V2 task ${taskId} is not defined in the task suite`);
  return task;
}
