#!/usr/bin/env node
// Validate the frozen RCD S0 task suite and record a content-free source/environment manifest.
// Runtime run evidence remains in its existing stores; this tool does not copy user data.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suitePath = resolve(root, 'scripts/rcd-s0-scenarios.json');
const suiteBytes = readFileSync(suitePath);
const suite = JSON.parse(suiteBytes.toString('utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function validate() {
  const errors = [];
  const required = ['id', 'category', 'kind', 'task', 'environment', 'tools', 'permissions', 'oracle', 'acceptableStops', 'prohibited', 'reset'];
  const scenarios = suite.scenarios;
  const ids = new Set();
  const counts = {};
  for (const [index, scenario] of scenarios.entries()) {
    for (const key of required) if (scenario[key] === undefined || scenario[key] === '' || scenario[key] === null) errors.push(`${scenario.id ?? index}: missing ${key}`);
    if (!/^[CFRLX]\d{2}$/u.test(scenario.id ?? '')) errors.push(`${index}: invalid scenario id`);
    if (ids.has(scenario.id)) errors.push(`${scenario.id}: duplicate id`);
    ids.add(scenario.id);
    counts[scenario.category] = (counts[scenario.category] ?? 0) + 1;
    if (!Array.isArray(scenario.tools) || scenario.tools.length === 0) errors.push(`${scenario.id}: tools must be a non-empty list`);
    if (!Array.isArray(scenario.acceptableStops) || scenario.acceptableStops.length === 0) errors.push(`${scenario.id}: acceptableStops must be a non-empty list`);
    if (!Array.isArray(scenario.prohibited) || scenario.prohibited.length === 0) errors.push(`${scenario.id}: prohibited must be a non-empty list`);
  }
  if (scenarios.length !== 24) errors.push(`expected 24 scenarios, got ${scenarios.length}`);
  for (const category of ['C', 'F', 'R', 'L', 'X']) {
    if (counts[category] !== suite.categories[category]) errors.push(`${category}: declared ${suite.categories[category]}, actual ${counts[category] ?? 0}`);
  }
  const kinds = new Set(scenarios.map((scenario) => scenario.kind));
  for (const kind of ['positive', 'safe_block', 'recovery']) if (!kinds.has(kind)) errors.push(`missing scenario kind ${kind}`);
  if (errors.length) {
    process.stderr.write(`${errors.map((error) => `- ${error}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`PASS ${suite.suiteId}: ${scenarios.length} scenarios (${Object.entries(counts).sort().map(([key, value]) => `${key}=${value}`).join(', ')})\n`);
  process.stdout.write(`suiteSha256=${sha256(suiteBytes)}\n`);
}

function manifest(output) {
  const packageJson = readFileSync(resolve(root, 'package.json'));
  const lockPath = resolve(root, 'pnpm-lock.yaml');
  const lockBytes = readFileSync(lockPath);
  const status = git('status', '--short', '--untracked-files=all').split(/\r?\n/u).filter(Boolean);
  const nameStatus = git('diff', '--name-status', 'HEAD');
  const diffHash = sha256(git('diff', '--binary', 'HEAD'));
  const result = {
    schemaVersion: 1,
    suiteId: suite.suiteId,
    capturedAt: new Date().toISOString(),
    source: {
      head: git('rev-parse', 'HEAD'),
      branch: git('branch', '--show-current'),
      dirty: status.length > 0,
      statusEntries: status,
      trackedDiffNameStatus: nameStatus ? nameStatus.split(/\r?\n/u) : [],
      trackedDiffSha256: diffHash,
    },
    environment: {
      node: process.version,
      pnpm: execFileSync('pnpm --version', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true }).trim(),
      platform: process.platform,
      arch: process.arch,
      packageJsonSha256: sha256(packageJson),
      lockfileSha256: sha256(lockBytes),
      suiteSha256: sha256(suiteBytes),
    },
    baseline: {
      deterministicSuite: 'not_executed',
      localRuntimeE2E: 'not_executed',
      realProvider: 'not_run',
      note: 'Populate only from observed runs; missing usage and price data must remain unavailable.',
    },
    evidencePolicy: {
      rawUserContentPersisted: false,
      runtimeEvidenceSource: 'existing execution logs, durable checkpoints, provider usage records, tool invocation records, and context snapshots; see S0 report',
    },
  };
  if (output) writeFileSync(resolve(output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${output ? `Wrote ${output}` : JSON.stringify(result, null, 2)}\n`);
}

const adapters = new Set(['C01','C02','C03','C04','C05','C06','C07','C08','F01','F02','F03','F04','R01','R02','R03','R04','L01','L02','L03','L04','X01','X02','X03','X04']);
const coreScenarioIds = new Set(['C02', 'C08', 'R01', 'R02', 'L01', 'X01']);
const safeJson = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
};

function worktreeFingerprint() {
  const status = git('status', '--short', '--untracked-files=all').split(/\r?\n/u).filter(Boolean);
  const tracked = git('diff', '--binary', 'HEAD');
  const untracked = status.filter((line) => line.startsWith('?? ')).map((line) => line.slice(3));
  const entries = [tracked, ...untracked.map((path) => {
    try { return `${path}\0${readFileSync(resolve(root, path))}`; } catch { return `${path}\0unreadable`; }
  })];
  return { head: git('rev-parse', 'HEAD'), dirty: status.length > 0, statusEntries: status, sha256: sha256(entries.join('\0')) };
}

function collectFiles(directory, prefix = '') {
  const values = [];
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const relative = join(prefix, item.name);
    if (item.isDirectory()) values.push(...collectFiles(join(directory, item.name), relative));
    else values.push(relative);
  }
  return values;
}

function runScenario(scenario, trial, timeoutMs) {
  if (!adapters.has(scenario.id)) return { scenarioId: scenario.id, trial, infrastructureStatus: 'not_run', productResult: 'unverified', reason: 'No executable adapter is implemented yet.' };
  const startedAt = new Date();
  const started = Date.now();
  const runRoot = resolve(tmpdir(), `ls-rcd-s0b-${process.pid}-${Date.now()}-${scenario.id}-${trial}`);
  const workspace = join(runRoot, 'workspace');
  // Keep the harness result channel outside the task workspace tree. A tool or
  // sandbox cleanup affecting the temporary workspace must not erase the
  // observation artifact needed to distinguish a product failure from a
  // harness failure.
  const observationPath = `${runRoot}.observation.json`;
  let infrastructureStatus = 'executed';
  let error;
  let observation;
  let exitCode;
  let stdout = '';
  let stderr = '';
  let timeout = false;
  let cleanup = { attempted: true, succeeded: false, residuals: [] };
  try {
    mkdirSync(workspace, { recursive: true });
    const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
    const result = execFileSync(process.execPath, [vitest, 'run', 'test/rcd-s0-adapters.test.ts', '-t', scenario.id], {
      cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, RCD_S0_SCENARIO_ID: scenario.id, RCD_S0_WORKSPACE: workspace, RCD_S0_OBSERVATION: observationPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    stdout = result;
    exitCode = 0;
    observation = safeJson(observationPath);
    if (!observation) throw new Error('Adapter completed without a readable observation artifact.');
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    exitCode = typeof cause?.status === 'number' ? cause.status : null;
    timeout = cause?.code === 'ETIMEDOUT';
    stdout = String(cause?.stdout ?? '');
    stderr = String(cause?.stderr ?? '');
    observation = safeJson(observationPath);
    infrastructureStatus = timeout ? 'blocked' : 'harness_error';
  } finally {
    try {
      const before = existsSync(runRoot) ? collectFiles(runRoot) : [];
      rmSync(runRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      rmSync(observationPath, { force: true, maxRetries: 2, retryDelay: 100 });
      const residuals = [
        ...(existsSync(runRoot) ? before : []),
        ...(existsSync(observationPath) ? [`${observationPath} (observation artifact)`] : []),
      ];
      cleanup = { attempted: true, succeeded: !existsSync(runRoot) && !existsSync(observationPath), residuals };
      if (!cleanup.succeeded) infrastructureStatus = 'harness_error';
    } catch (cause) {
      cleanup = {
        attempted: true,
        succeeded: false,
        residuals: [
          ...(existsSync(runRoot) ? collectFiles(runRoot) : []),
          ...(existsSync(observationPath) ? [`${observationPath} (observation artifact)`] : []),
        ],
        error: cause instanceof Error ? cause.message : String(cause),
      };
      infrastructureStatus = 'harness_error';
    }
  }
  const payload = observation?.observation ?? {};
  const productResult = payload.productResult ?? 'unverified';
  const configDigest = sha256(JSON.stringify({ adapter: scenario.id, model: 'rcd/scripted-provider', provider: 'scripted-mock', timeoutMs }));
  return {
    scenarioId: scenario.id, category: scenario.category, trial,
    source: worktreeFingerprint(), scenarioDefinitionSha256: sha256(JSON.stringify(scenario)),
    runnerHarness: { adapter: scenario.id, model: 'rcd/scripted-provider', configSha256: configDigest, executionLayer: payload.testLayer ?? 'vitest_adapter' },
    provider: { type: 'scripted-mock', simulated: true, externalRequests: 'loopback_only' },
    startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(), durationMs: Date.now() - started,
    exitCode, timeout, toolCalls: payload.toolCallCount ?? payload.shellExecutionCount ?? payload.completedOperations ?? payload.toolExecutions ?? null,
    toolFailures: payload.toolFailures ?? payload.invocationStatuses ?? payload.shellResults ?? payload.webDisabledError ?? null,
    stopReason: payload.stopReason ?? (timeout ? 'timeout' : null), authorization: payload.authorization ?? 'unavailable',
    sideEffects: payload.sideEffects ?? payload.sideEffectStatus ?? 'unavailable',
    oracle: { result: productResult, description: payload.oracle ?? scenario.oracle, evidenceRefs: payload.fixtureEvidence ?? payload.evidenceRefs ?? [], observation: payload },
    infrastructureStatus, cleanup, usage: { status: 'unavailable', promptTokens: null, completionTokens: null, cost: null },
    error, outputDigests: { stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr) },
  };
}

function run(args) {
  const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const requestedId = value('id');
  const requestedCategory = value('category')?.toUpperCase();
  const all = args.includes('--all');
  const core = args.includes('--core');
  const trialCount = Number(value('trials') ?? 1);
  const timeoutMs = Number(value('timeout-ms') ?? 120_000);
  if (Number(Boolean(requestedId) + Boolean(requestedCategory) + Number(all) + Number(core)) !== 1 || !Number.isInteger(trialCount) || trialCount < 1 || trialCount > 20 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000) {
    process.stderr.write('Usage: node scripts/rcd-s0.mjs run (--id=C02 | --category=C | --core | --all) [--trials=1] [--timeout-ms=120000] [--output=<path>]\n');
    process.exitCode = 2;
    return;
  }
  const selected = suite.scenarios.filter((scenario) => all || (core && coreScenarioIds.has(scenario.id)) || scenario.id === requestedId || scenario.category === requestedCategory);
  if (requestedId && selected.length !== 1) { process.stderr.write(`Unknown scenario: ${requestedId}\n`); process.exitCode = 2; return; }
  if (requestedCategory && !selected.length) { process.stderr.write(`Unknown category: ${requestedCategory}\n`); process.exitCode = 2; return; }
  const records = [];
  for (const scenario of selected) for (let trial = 1; trial <= trialCount; trial++) records.push(runScenario(scenario, trial, timeoutMs));
  const grouped = records.reduce((groups, record) => { (groups[record.scenarioId] ??= []).push(record); return groups; }, {});
  const stability = Object.values(grouped).map((items) => {
    const signatures = items.map((record) => sha256(JSON.stringify({ oracle: record.oracle?.result, stopReason: record.stopReason, sideEffects: record.sideEffects, authorization: record.authorization, infrastructureStatus: record.infrastructureStatus, cleanup: record.cleanup?.succeeded })));
    return { scenarioId: items[0].scenarioId, trials: items.length, stable: new Set(signatures).size === 1, signatureCount: new Set(signatures).size };
  });
  const result = {
    schemaVersion: 1, suiteId: suite.suiteId, runId: `rcd-s0b-${Date.now()}`, generatedAt: new Date().toISOString(), source: worktreeFingerprint(),
    selection: { id: requestedId ?? null, category: requestedCategory ?? null, core, all, trials: trialCount },
    freeze: core ? {
      id: 'RCD-S0-F',
      conclusion: 'Six core mechanism baselines established; the complete 24-scenario baseline is incomplete.',
      coreScenarioIds: [...coreScenarioIds],
      fullSuiteStatus: 'incomplete',
      remainingScenarioStatus: 'unverified',
    } : undefined,
    infrastructure: { executed: records.filter((record) => record.infrastructureStatus === 'executed').length, blocked: records.filter((record) => record.infrastructureStatus === 'blocked').length, harnessError: records.filter((record) => record.infrastructureStatus === 'harness_error').length, notRun: records.filter((record) => record.infrastructureStatus === 'not_run').length },
    productResults: Object.fromEntries(['passed', 'failed', 'partially_completed', 'correctly_blocked', 'unverified'].map((status) => [status, records.filter((record) => record.oracle?.result === status).length])),
    stability, records,
  };
  const outputPath = value('output') ? resolve(value('output')) : resolve(tmpdir(), 'littlesheep-rcd-s0-evidence', `${result.runId}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ output: outputPath, infrastructure: result.infrastructure, productResults: result.productResults }, null, 2)}\n`);
  if (records.some((record) => record.infrastructureStatus === 'harness_error' || record.infrastructureStatus === 'blocked')) process.exitCode = 1;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'validate') validate();
else if (command === 'manifest') {
  const outputArg = args.find((arg) => arg.startsWith('--output='));
  manifest(outputArg ? outputArg.slice('--output='.length) : undefined);
} else if (command === 'run') run(args);
else {
  process.stderr.write('Usage: node scripts/rcd-s0.mjs validate | manifest [--output=<path>] | run (--id=<id> | --category=<category> | --core | --all) [--trials=1] [--timeout-ms=120000] [--output=<path>]\n');
  process.exitCode = 2;
}
