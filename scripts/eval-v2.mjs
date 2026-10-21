#!/usr/bin/env node
// R4-B V2 evaluator CLI.
//
// Deliberately thin: task execution is delegated to the existing vitest adapter
// pattern (test/v2-task-adapters.test.ts) with the real Runner/Harness/Tools and
// a scripted provider. This CLI adds task selection, controlled-run dispatch and
// the versioned task-suite validation. Trial identity, immutable ledgers and the
// batch report are layered on in R4-B3/R4-B4.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CONTRACT_VERSION, DIMENSION_NAMES, REPO_ROOT, SUITE_ID, TRIAL_MAX, TRIAL_MIN } from './lib/r4b/contract.mjs';
import { loadTaskSuite } from './lib/r4b/tasks.mjs';

const root = REPO_ROOT;

function usage() {
  process.stderr.write([
    'Usage:',
    '  node scripts/eval-v2.mjs --suite',
    '  node scripts/eval-v2.mjs --run-controlled --task=<ID> [--variant=canonical|wrong-field] [--fault-mode=inject|none|no-recovery|duplicate] [--output-dir=<dir>] [--trial=<1..5>]',
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
  return { loaded, task, trial, variant, faultMode };
}

function executeControlled(selection, values) {
  const { loaded, task, trial, variant, faultMode } = selection;
  const runRoot = mkdtempSync(join(tmpdir(), `ls-v2-run-${task.id.toLowerCase()}-t${trial}-`));
  const observationPath = join(runRoot, 'observation.json');
  let child;
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
        V2_TASK_ROOT: join(runRoot, 'task'),
        V2_OBSERVATION_PATH: observationPath,
        V2_VARIANT: variant,
        V2_FAULT_MODE: faultMode,
      },
    });
  } finally {
    // The child writes inside runRoot; keep it until the observation is read.
  }
  const output = sanitize(`${child?.stdout ?? ''}${child?.stderr ?? ''}`);
  const diagnostics = { exitCode: child?.status ?? null, timedOut: child?.error?.code === 'ETIMEDOUT', output: output.slice(-8000) };
  let observation = null;
  if (existsSync(observationPath)) {
    try { observation = JSON.parse(readFileSync(observationPath, 'utf8')); } catch (error) { diagnostics.parseError = String(error?.message ?? error); }
  }
  const cleanup = { attempted: true, succeeded: false, residuals: [] };
  try {
    rmSync(runRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    cleanup.succeeded = !existsSync(runRoot);
    if (!cleanup.succeeded) cleanup.residuals.push(runRoot);
  } catch {
    cleanup.residuals.push(runRoot);
  }
  if (!observation) {
    throw Object.assign(new Error(`V2 controlled run produced no observation: ${output.slice(-2000)}`), { diagnostics });
  }
  const summary = {
    taskId: task.id,
    taskVersion: task.version,
    trial,
    variant,
    faultMode,
    suiteSha256: loaded.suiteSha256,
    dimensions: observation.observation?.dimensions ?? {},
    runtime: observation.observation?.runtime ?? {},
    files: observation.observation?.files ?? [],
    successfulExecutions: observation.observation?.successfulExecutions ?? null,
    duplicateSuccessfulEffects: observation.observation?.duplicateSuccessfulEffects ?? null,
    safety: observation.observation?.safety ?? null,
    cleanup,
    diagnostics,
    observation,
  };
  const outputDir = values.get('--output-dir');
  if (outputDir) {
    mkdirSync(outputDir, { recursive: true });
    const recordPath = resolve(outputDir, `v2-observation-${task.id}-${variant}-${faultMode}-trial-${trial}.json`);
    if (existsSync(recordPath)) throw new Error(`Refusing to overwrite an existing observation: ${recordPath}`);
    writeFileSync(recordPath, `${JSON.stringify(observation, null, 2)}\n`, 'utf8');
    summary.recordPath = recordPath;
  }
  const expected = DIMENSION_NAMES.map((name) => summary.dimensions[name]?.status ?? 'missing');
  process.stdout.write(`${JSON.stringify({
    taskId: task.id, variant, faultMode, trial,
    dimensions: Object.fromEntries(DIMENSION_NAMES.map((name) => [name, summary.dimensions[name]?.status ?? 'missing'])),
    successfulExecutions: summary.successfulExecutions,
    duplicateSuccessfulEffects: summary.duplicateSuccessfulEffects,
    cleanup,
    recordPath: summary.recordPath ?? null,
    expected,
  }, null, 2)}\n`);
  if (summary.runtime?.infrastructureStatus && summary.runtime.infrastructureStatus !== 'executed') process.exitCode = 1;
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
  process.stderr.write(`${sanitize(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
}
