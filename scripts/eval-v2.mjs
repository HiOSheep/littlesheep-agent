#!/usr/bin/env node
// R4-B V2 evaluator CLI.
//
// Deliberately thin: task execution is delegated to the existing vitest adapter
// pattern (test/v2-task-adapters.test.ts) with the real Runner/Harness/Tools and
// a scripted provider. This CLI adds task selection, trial identity, immutable
// record writing and validation. The batch ledger/report are produced in R4-B4.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CONTRACT_SCHEMA_PATH, CONTRACT_VERSION, DIMENSION_NAMES, REPO_ROOT, SUITE_ID, TRIAL_MAX, TRIAL_MIN,
  computeEvaluatorFingerprint, gitProductState, sha256File,
} from './lib/r4b/contract.mjs';
import { loadTaskSuite } from './lib/r4b/tasks.mjs';
import { DEFAULT_BATCH_ID, createTrial } from './lib/r4b/trials.mjs';
import { buildRecord } from './lib/r4b/record.mjs';
import { RECORDS_DIR, writeRecordAtomic } from './lib/r4b/ledger.mjs';

const root = REPO_ROOT;

function usage() {
  process.stderr.write([
    'Usage:',
    '  node scripts/eval-v2.mjs --suite',
    '  node scripts/eval-v2.mjs --run-controlled --task=<ID> [--variant=canonical|wrong-field] [--fault-mode=inject|none|no-recovery|duplicate] [--trial=<1..5>] [--batch=<id>] [--records-dir=<dir>]',
    '  node scripts/eval-v2.mjs --verify',
  ].join('\n') + '\n');
}

function argsOf(argv) {
  const flags = new Set(argv.filter((value) => !value.includes('=')));
  const values = new Map(argv.filter((value) => value.includes('=')).map((value) => {
    const index = value.indexOf('=');
    return [value.slice(0, index), value.slice(index + 1)];
  }));
  return { flags, values };
}

function runSuite() {
  const loaded = loadTaskSuite();
  process.stdout.write(`${JSON.stringify({
    suiteId: SUITE_ID,
    contractVersion: CONTRACT_VERSION,
    suiteSha256: loaded.suiteSha256,
    tasks: loaded.tasks.map((task) => ({
      id: task.id,
      version: task.version,
      ancestry: task.ancestry,
      dimensions: task.dimensions,
      contract: task.contract?.ref ?? null,
      faultFixture: task.faultFixture?.kind ?? null,
      taskDefinitionSha256: task.taskDefinitionSha256,
    })),
  }, null, 2)}\n`);
}

function sanitize(text, secret = '') {
  let output = String(text ?? '');
  if (secret) output = output.split(secret).join('[redacted]');
  return output.replace(/(?:api[-_]?key|authorization|bearer)\s*[:=]\s*[^\s"']+/giu, '[redacted]');
}

function runV2Tests() {
  const testFiles = [
    'scripts/lib/r4b/contract.test.mjs',
    'scripts/lib/r4b/tasks.test.mjs',
    'scripts/lib/r4b/oracles.test.mjs',
    'test/v2-trial-budget.test.ts',
    'scripts/lib/r4b/e2e.test.mjs',
  ];
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...testFiles], {
    cwd: root, encoding: 'utf8', timeout: 900_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, V2_E2E: '1' },
  });
  const output = sanitize(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  process.stdout.write(`${JSON.stringify({
    check: 'v2-contract-oracles',
    exitCode: result.status,
    output: output.slice(-20_000),
    outputSha256: createHash('sha256').update(output).digest('hex'),
  }, null, 2)}\n`);
  if (result.status !== 0) process.exitCode = 1;
}

function selectControlledRun(values) {
  const loaded = loadTaskSuite();
  const taskId = values.get('--task');
  if (!taskId) throw new Error('--task is required for --run-controlled');
  const task = loaded.tasks.find((entry) => entry.id === taskId);
  if (!task) throw new Error(`Unknown V2 task: ${taskId}`);
  const batchId = values.get('--batch') ?? DEFAULT_BATCH_ID;
  const trial = values.get('--trial') === undefined ? 1 : Number(values.get('--trial'));
  if (!Number.isSafeInteger(trial) || trial < TRIAL_MIN || trial > TRIAL_MAX) {
    throw new Error(`--trial must be an integer from ${TRIAL_MIN} to ${TRIAL_MAX}`);
  }
  const variant = values.get('--variant') ?? 'canonical';
  const faultMode = values.get('--fault-mode') ?? (task.faultFixture ? 'inject' : 'none');
  if (task.id === 'FILE-02-S' && !['canonical', 'wrong-field'].includes(variant)) throw new Error(`Unsupported variant for ${task.id}: ${variant}`);
  if (task.id !== 'FILE-02-S' && variant !== 'canonical') throw new Error(`Variant ${variant} is only defined for FILE-02-S`);
  if (task.faultFixture) {
    if (!['inject', 'none', 'no-recovery', 'duplicate'].includes(faultMode)) throw new Error(`Unsupported fault mode: ${faultMode}`);
  } else if (faultMode !== 'none') {
    throw new Error(`Fault mode ${faultMode} is only defined for a task with a fault fixture`);
  }
  return { loaded, task, trial, batchId, variant, faultMode };
}

function executeControlled(selection, values) {
  const { loaded, task, trial, batchId, variant, faultMode } = selection;
  const trialContext = createTrial({ batchId, taskId: task.id, trial });
  const observationPath = join(trialContext.root, 'observation.json');
  let child;
  let observation = null;
  try {
    child = spawnSync(process.execPath, [
      'node_modules/vitest/vitest.mjs', 'run', 'test/v2-task-adapters.test.ts', '-t', `V2 ${task.id}`,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        V2_TASK_ID: task.id,
        V2_TASK_ROOT: join(trialContext.root, 'task'),
        V2_OBSERVATION_PATH: observationPath,
        V2_VARIANT: variant,
        V2_FAULT_MODE: faultMode,
      },
    });
    if (existsSync(observationPath)) {
      try { observation = JSON.parse(readFileSync(observationPath, 'utf8')); } catch { observation = null; }
    }
  } finally {
    // Temp trial state is removed once the observation has been loaded; the
    // immutable record lives outside the trial root.
    try {
      rmSync(trialContext.root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch { /* recorded below via residual check */ }
  }
  const output = sanitize(`${child?.stdout ?? ''}${child?.stderr ?? ''}`);
  const diagnostics = { exitCode: child?.status ?? null, timedOut: child?.error?.code === 'ETIMEDOUT', output: output.slice(-8000) };
  if (!observation) {
    throw Object.assign(new Error(`V2 controlled run produced no observation: ${output.slice(-2000)}`), { diagnostics });
  }
  const evaluatorFingerprint = computeEvaluatorFingerprint();
  const evaluatorCommand = `node scripts/eval-v2.mjs --run-controlled --task=${task.id} --trial=${trial} --batch=${batchId}`
    + (variant !== 'canonical' ? ` --variant=${variant}` : '')
    + (task.faultFixture ? ` --fault-mode=${faultMode}` : '');
  const record = buildRecord({
    loaded,
    task,
    trial,
    batchId,
    observation,
    gitState: gitProductState(),
    evaluatorFingerprint,
    contractSha256: sha256File(join(root, CONTRACT_SCHEMA_PATH)),
    taskSuiteSha256: loaded.suiteSha256,
    command: evaluatorCommand,
    variant: variant === 'canonical' ? null : variant,
    faultMode: task.faultFixture ? faultMode : null,
  });
  const recordsDir = resolve(root, values.get('--records-dir') ?? RECORDS_DIR);
  let written;
  try {
    written = writeRecordAtomic({ dir: recordsDir, record, task, options: { expectedFingerprint: evaluatorFingerprint } });
  } catch (error) {
    if (error?.code === 'LEDGER_RECORD_EXISTS') throw error;
    if (error?.code === 'V2_RECORD_INVALID' || error?.code === 'EVALUATION_RECORD_INVALID') throw error;
    throw error;
  }
  const cleanup = { attempted: true, succeeded: !existsSync(trialContext.root), residuals: existsSync(trialContext.root) ? [trialContext.root] : [] };
  process.stdout.write(`${JSON.stringify({
    taskId: task.id,
    taskVersion: task.version,
    trial,
    batchId,
    variant,
    faultMode,
    recordId: record.recordId,
    recordPath: written.path,
    dimensions: Object.fromEntries(DIMENSION_NAMES.map((name) => [name, record.dimensions[name]?.status ?? 'missing'])),
    successfulExecutions: observation.observation?.successfulExecutions ?? null,
    duplicateSuccessfulEffects: observation.observation?.duplicateSuccessfulEffects ?? null,
    cleanup,
    diagnostics,
  }, null, 2)}\n`);
  if (record.execution.infrastructureStatus !== 'executed' || cleanup.succeeded !== true) process.exitCode = 1;
}

function main(argv) {
  const { flags, values } = argsOf(argv);
  const modes = ['--suite', '--run-controlled', '--verify'].filter((flag) => flags.has(flag));
  if (modes.length !== 1) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (modes[0] === '--suite') {
    runSuite();
    return;
  }
  if (modes[0] === '--verify') {
    if (!existsSync(join(root, 'scripts/lib/r4b/contract.test.mjs'))) throw new Error('V2 test files are missing');
    runV2Tests();
    return;
  }
  executeControlled(selectControlledRun(values), values);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown V2 evaluator failure';
  process.stderr.write(`${sanitize(message)}\n`);
  process.exitCode = 1;
}
