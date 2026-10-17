#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frozenHead = 'd5015136ca9cf9583423361263b5bacba257a385';
const taskSuitePath = join(root, 'docs/reference/rcd-s3a-task-suite-2026-10-17.json');
const scenarioSuitePath = join(root, 'scripts/rcd-s0-scenarios.json');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const adapterMetadata = {
  C01: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  C02: { adapter: 'schema_correction', layer: 'Harness execute-stage + ToolExecutionService', oracle: 'external_temp_file_and_invocation_record', providerSimulated: true, reproducible: true, frozenResult: 'failed' },
  C03: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  C04: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  C05: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  C06: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  C07: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  C08: { adapter: 'same_shell_command_twice', layer: 'Harness execute-stage + real built-in exec with fixture-only authority', oracle: 'external_command_log_and_file_hashes', providerSimulated: true, reproducible: true, frozenResult: 'passed' },
  F01: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  F02: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  F03: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  F04: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  R01: { adapter: 'mid_task_loopback_retrieval', layer: 'Harness execute-stage + built-in web_search + local HTTP fixture', oracle: 'local_server_request_and_response', providerSimulated: true, reproducible: true, frozenResult: 'failed' },
  R02: { adapter: 'paired_allow_deny_web', layer: 'Harness execute-stage + built-in web_search with network policy', oracle: 'paired_local_request_counts', providerSimulated: true, reproducible: true, frozenResult: 'correctly_blocked' },
  R03: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  R04: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  L01: { adapter: 'bounded_30_of_35_operations', layer: 'Harness main execute loop + scripted Provider + fixture Tool', oracle: 'external_item_count_and_loop_stop', providerSimulated: true, reproducible: true, frozenResult: 'partially_completed' },
  L02: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  L03: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  L04: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  X01: { adapter: 'post_effect_controlled_exception_restart', layer: 'durable Runner + restart recovery with injected exception (not OS process crash)', oracle: 'external_effect_file_and_unknown_ledger', providerSimulated: true, reproducible: true, frozenResult: 'correctly_blocked' },
  X02: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  X03: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
  X04: { adapter: 'generic_fixture_operation', layer: 'Harness + ToolExecutionService component adapter', oracle: 'component_effect_only', providerSimulated: true, reproducible: true },
};

// Generated reports are evaluator artifacts too, but their changing timestamps
// and run records must not make the evaluator fingerprint self-referential.
const evaluatorArtifactPaths = [
  /^docs\/reference\/rcd-s3a-/u,
  /^scripts\/s3a-eval\.mjs$/u,
  /^test\/s3a-task-adapters\.test\.ts$/u,
  /^scripts\/README\.md$/u,
  /^docs\/reference\/README\.md$/u,
];
const evaluatorFingerprintFiles = [
  'docs/reference/rcd-s3a-evaluation-protocol-2026-10-17.md',
  'docs/reference/rcd-s3a-metrics-schema-2026-10-17.json',
  'docs/reference/rcd-s3a-task-suite-2026-10-17.json',
  'scripts/s3a-eval.mjs',
  'test/s3a-task-adapters.test.ts',
];

function gitState() {
  const head = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const statusText = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  const status = statusText.split(/\r?\n/u).filter(Boolean);
  const paths = status.map((entry) => entry.slice(3).replaceAll('\\', '/'));
  const evaluatorChanges = paths.filter((path) => evaluatorArtifactPaths.some((pattern) => pattern.test(path)));
  const committedPaths = head === frozenHead ? [] : git('diff', '--name-only', frozenHead, head).split(/\r?\n/u).filter(Boolean);
  const committedProductChanges = committedPaths.filter((path) => !evaluatorArtifactPaths.some((pattern) => pattern.test(path)));
  const productChanges = [
    ...paths.filter((path) => !evaluatorArtifactPaths.some((pattern) => pattern.test(path))),
    ...committedProductChanges,
  ];
  const diff = git('diff', '--binary', 'HEAD');
  const evaluatorBytes = evaluatorFingerprintFiles.map((path) => {
    try { return `${path}\0${readFileSync(join(root, path))}`; } catch { return `${path}\0unreadable`; }
  }).join('\0');
  const frozenProductTree = git('rev-parse', `${frozenHead}^{tree}`);
  const frozenBaseIsAncestor = git('merge-base', frozenHead, head) === frozenHead;
  return {
    head,
    committedTree: tree,
    frozenProductTree,
    status,
    dirtyPaths: paths,
    productChanges,
    evaluatorChanges,
    trackedDiffSha256: sha256(diff),
    evaluatorFingerprint: sha256(evaluatorBytes),
    workingTreeFingerprint: sha256(`${tree}\0${diff}\0${evaluatorBytes}`),
    productSourceDirty: productChanges.length > 0 || !frozenBaseIsAncestor,
    baselineQualification: productChanges.length > 0 || !frozenBaseIsAncestor
      ? 'non_frozen_product_source'
      : head !== frozenHead ? 'frozen_product_source_with_evaluator_commit'
        : status.length > 0 ? 'product_commit_with_evaluator_overlay' : 'frozen_commit_clean',
  };
}

function environment() {
  let pnpm = 'unavailable';
  try { pnpm = execFileSync('pnpm --version', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true }).trim(); } catch { /* Keep unavailable explicit. */ }
  const packageJson = readJson(join(root, 'package.json'));
  const appPackage = readJson(join(root, 'packages/app/package.json'));
  let installedElectron = appPackage.devDependencies?.electron ?? appPackage.dependencies?.electron ?? packageJson.devDependencies?.electron ?? null;
  try { installedElectron = readJson(join(root, 'node_modules/electron/package.json')).version; } catch { /* Keep the declared range if installation is unavailable. */ }
  return {
    os: `${process.platform} ${process.getSystemVersion?.() ?? ''}`.trim(),
    arch: process.arch,
    node: process.version,
    pnpm,
    electron: installedElectron,
    electronBinaryAvailable: existsSync(join(root, 'node_modules/electron/dist/electron.exe')),
    lockfileSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
  };
}

function auditScenarios(outputPath = join(root, 'docs/reference/rcd-s3a-scenario-audit-2026-10-17.json')) {
  const source = readJson(scenarioSuitePath);
  const frozen = readJson(join(root, 'docs/reference/rcd-s0f-core-baseline-2026-10-16.json'));
  const baselineById = new Map((frozen.records ?? []).map((record) => [record.scenarioId, record.oracle?.result ?? 'unverified']));
  const scenarios = source.scenarios.map((scenario) => {
    const metadata = adapterMetadata[scenario.id] ?? {};
    const fullScenarioAdapter = Boolean(metadata.frozenResult);
    return {
      id: scenario.id,
      category: scenario.category,
      kind: scenario.kind,
      task: scenario.task,
      declaredOracle: scenario.oracle,
      executionAdapter: metadata.adapter ?? 'missing',
      executionLayer: metadata.layer ?? 'not assessed',
      actualRunnerHarnessPath: fullScenarioAdapter,
      oracleScope: metadata.oracle ?? 'none',
      externalOracleForDeclaredScenario: fullScenarioAdapter,
      providerSimulated: metadata.providerSimulated ?? null,
      realModelRequiredForOpenTaskClaim: true,
      currentAdapterNeedsRealModel: false,
      replayableInputAndInitialState: metadata.reproducible ?? false,
      frozenS0FResult: metadata.frozenResult ?? 'unverified',
      latestRecordedFrozenResult: baselineById.get(scenario.id) ?? null,
      assessment: fullScenarioAdapter
        ? 'scenario adapter executes the represented mechanism at the listed layer; controlled Provider is not a real-model capability result'
        : 'generic fixture effect only; declared scenario trigger and independent scenario Oracle are not implemented; retain unverified',
    };
  });
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    suiteId: source.suiteId,
    suiteSha256: sha256(readFileSync(scenarioSuitePath)),
    productHead: git('rev-parse', 'HEAD'),
    scope: 'Adapter and Oracle audit; the 24 definitions are not 24 successful task trials.',
    counts: {
      definitions: scenarios.length,
      scenarioSpecificAdapters: scenarios.filter((entry) => entry.actualRunnerHarnessPath).length,
      genericComponentProbes: scenarios.filter((entry) => !entry.actualRunnerHarnessPath && entry.executionAdapter !== 'missing').length,
      externalScenarioOracles: scenarios.filter((entry) => entry.externalOracleForDeclaredScenario).length,
      unverifiedScenarioDefinitions: scenarios.filter((entry) => !entry.actualRunnerHarnessPath).length,
      simulatedProviderAdapters: scenarios.filter((entry) => entry.providerSimulated === true).length,
    },
    scenarios,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { path: outputPath, result };
}

function runTask(taskId, trial = 1) {
  const suite = readJson(taskSuitePath);
  const task = suite.tasks.find((item) => item.id === taskId);
  if (!task || task.adapter?.status !== 'implemented_and_run') throw new Error(`No executable adapter exists for ${taskId}; keep it not_run.`);
  const sourceBefore = gitState();
  const envBefore = environment();
  const taskRoot = join(tmpdir(), `ls-s3a-${process.pid}-${Date.now()}-${taskId.toLowerCase()}-${trial}`);
  const observationPath = `${taskRoot}.observation.json`;
  mkdirSync(taskRoot, { recursive: true });
  const vitest = join(root, 'node_modules/vitest/vitest.mjs');
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let childResult;
  let observation;
  let error = null;
  let stdout = '';
  let stderr = '';
  let cleanup = { attempted: true, succeeded: false, residuals: [] };
  let infrastructureStatus = 'executed';
  try {
    childResult = execFileSync(process.execPath, [vitest, 'run', 'test/s3a-task-adapters.test.ts', '-t', `S3A ${taskId}`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, S3A_TASK_ID: taskId, S3A_TASK_ROOT: taskRoot, S3A_OBSERVATION_PATH: observationPath },
    });
    stdout = childResult;
    if (existsSync(observationPath)) observation = readJson(observationPath);
    if (!observation) throw new Error('Adapter did not save its independent observation report.');
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    stdout = String(cause?.stdout ?? '');
    stderr = String(cause?.stderr ?? '');
    if (existsSync(observationPath)) observation = readJson(observationPath);
    infrastructureStatus = cause?.code === 'ETIMEDOUT' ? 'blocked' : 'harness_error';
  } finally {
    try {
      rmSync(taskRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      rmSync(observationPath, { force: true, maxRetries: 3, retryDelay: 100 });
      const residuals = [
        ...(existsSync(taskRoot) ? [taskRoot] : []),
        ...(existsSync(observationPath) ? [observationPath] : []),
      ];
      cleanup = { attempted: true, succeeded: residuals.length === 0, residuals };
      if (!cleanup.succeeded) infrastructureStatus = 'harness_error';
    } catch (cause) {
      cleanup = { attempted: true, succeeded: false, residuals: [taskRoot, observationPath].filter(existsSync), error: String(cause) };
      infrastructureStatus = 'harness_error';
    }
  }
  const sourceAfter = gitState();
  if (sourceBefore.head !== sourceAfter.head || sourceBefore.workingTreeFingerprint !== sourceAfter.workingTreeFingerprint) {
    infrastructureStatus = 'harness_error';
    error = `${error ? `${error}; ` : ''}The source/evaluator fingerprint changed during the trial.`;
  }
  const observationBody = observation?.observation ?? {};
  const oracle = observationBody.oracle ?? { status: 'unverified', method: 'no independent Oracle result was recorded', evidence: [] };
  const taskResult = oracle.taskResult ?? oracle.status ?? 'unverified';
  const usage = observationBody.usage ?? { status: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null, reason: 'controlled Provider has no physical usage receipt' };
  const runId = `s3a-${Date.now()}-${taskId.toLowerCase()}-${trial}`;
  return {
    schemaVersion: 1,
    recordId: runId,
    taskId,
    trial,
    evidenceTier: 'A_runtime_deterministic',
    source: {
      productHead: sourceBefore.head,
      productTreeFingerprint: sourceBefore.committedTree,
      frozenProductHead: frozenHead,
      frozenProductTreeFingerprint: sourceBefore.frozenProductTree,
      evaluatorFingerprint: sourceBefore.evaluatorFingerprint,
      workingTreeFingerprint: sourceBefore.workingTreeFingerprint,
      dirty: sourceBefore.status.length > 0,
      dirtyPaths: sourceBefore.dirtyPaths,
      baselineQualification: sourceBefore.baselineQualification,
      productSourceDirty: sourceBefore.productSourceDirty,
      fingerprintStableDuringTrial: sourceBefore.workingTreeFingerprint === sourceAfter.workingTreeFingerprint,
    },
    environment: {
      ...envBefore,
      taskDefinitionSha256: sha256(JSON.stringify(task)),
      configSha256: sha256(JSON.stringify({ taskId, permissionPreset: 'workspace-write', network: 'denied', controlledProvider: true, timeoutMs: 120_000 })),
      evaluatorCommand: `node scripts/s3a-eval.mjs --task=${taskId}`,
    },
    execution: {
      infrastructureStatus,
      runtimeStatus: observationBody.runtimeStatus ?? null,
      runtimeFinalStatus: observationBody.runtimeFinalStatus ?? null,
      stopReason: null,
      executionLayer: observationBody.executionLayer ?? task.adapter.layer,
      provider: observationBody.provider ?? { type: 'scripted', simulated: true },
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      modelRequests: observationBody.modelRequests ?? null,
      toolCalls: observationBody.toolCalls ?? null,
      toolExecutions: observationBody.toolExecutions ?? observationBody.actualToolExecutions ?? null,
      continuationSegments: null,
      contextCompactions: null,
      userInterventions: observationBody.userInterventions ?? { approvals: null, continueMessages: null },
      providerUsage: {
        status: usage.status ?? 'unavailable',
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        source: usage.source ?? null,
        reason: usage.reason ?? 'controlled Provider has no physical usage receipt',
      },
      cost: { status: 'unavailable', value: null, reason: 'no real Provider billing receipt' },
      safety: { duplicateEffects: 0, unknownEffects: null, unauthorizedToolAttempts: 0, forbiddenNetworkRequests: 0, recoveryAnomalies: null, falseCompletionClaims: null },
      childExitCode: infrastructureStatus === 'executed' ? 0 : null,
      outputDigests: { stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr) },
      error,
    },
    oracle: {
      result: taskResult,
      evaluationCheck: oracle.status ?? 'unverified',
      method: oracle.method ?? 'not recorded',
      requirements: [],
      unverifiedRequirementCount: null,
      falseCompletionClaim: null,
      evidenceRefs: (oracle.evidence ?? []).map((item) => typeof item === 'string' ? item : `fixture://${item.path ?? item.ref ?? 'evidence'}`),
      details: oracle,
      failureClassification: taskResult === 'failed'
        ? { primary: 'artifact_wrong_or_missing', secondary: [], evidenceRefs: (oracle.evidence ?? []).map((item) => typeof item === 'string' ? item : `fixture://${item.path ?? item.ref ?? 'evidence'}`) }
        : null,
    },
    cleanup,
  };
}

function run(args) {
  const outputArg = args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
  const outputPath = resolve(outputArg ?? join(root, 'docs/reference/rcd-s3a-baseline-2026-10-17.json'));
  const taskArg = args.find((arg) => arg.startsWith('--task='))?.slice('--task='.length);
  const runAll = args.includes('--run');
  const auditOnly = args.includes('--audit');
  const suiteOnly = args.includes('--suite');
  const modes = Number(Boolean(taskArg)) + Number(runAll) + Number(auditOnly) + Number(suiteOnly);
  if (modes !== 1) throw new Error('Choose one mode: --audit, --suite, --run, or --task=<ID>.');
  if (auditOnly) {
    const audit = auditScenarios(resolve(outputArg ?? join(root, 'docs/reference/rcd-s3a-scenario-audit-2026-10-17.json')));
    process.stdout.write(`${JSON.stringify({ output: audit.path, counts: audit.result.counts }, null, 2)}\n`);
    return;
  }
  const suite = readJson(taskSuitePath);
  if (suiteOnly) {
    const errors = [];
    if (suite.tasks.length !== 12) errors.push(`expected 12 task definitions, found ${suite.tasks.length}`);
    if (Object.values(suite.categories).reduce((sum, count) => sum + count, 0) !== 12) errors.push('category distribution must total 12');
    const ids = suite.tasks.map((task) => task.id);
    if (new Set(ids).size !== ids.length) errors.push('task IDs are not unique');
    for (const task of suite.tasks) for (const field of ['userInput', 'seed', 'allowedTools', 'authorization', 'successConditions', 'oracle', 'cleanup', 'security', 'adapter']) if (task[field] === undefined) errors.push(`${task.id} is missing ${field}`);
    if (errors.length) throw new Error(errors.join('\n'));
    process.stdout.write(`${JSON.stringify({ suiteId: suite.suiteId, taskCount: suite.tasks.length, categories: suite.categories, executableAdapters: suite.tasks.filter((task) => task.adapter.status === 'implemented_and_run').map((task) => task.id), suiteSha256: sha256(readFileSync(taskSuitePath)) }, null, 2)}\n`);
    return;
  }
  const selected = runAll ? suite.tasks.filter((task) => task.adapter?.status === 'implemented_and_run').map((task) => task.id) : [taskArg];
  const records = selected.map((taskId) => runTask(taskId));
  const baseline = {
    schemaVersion: 1,
    suiteId: suite.suiteId,
    generatedAt: new Date().toISOString(),
    selection: { mode: runAll ? 'available_controlled_adapters' : 'single_task', taskIds: selected },
    frozenProductHead: frozenHead,
    suiteSha256: sha256(readFileSync(taskSuitePath)),
    auditSha256: sha256(readFileSync(join(root, 'docs/reference/rcd-s3a-scenario-audit-2026-10-17.json'))),
    counts: {
      executed: records.filter((record) => record.execution.infrastructureStatus === 'executed').length,
      blocked: records.filter((record) => record.execution.infrastructureStatus === 'blocked').length,
      harnessError: records.filter((record) => record.execution.infrastructureStatus === 'harness_error').length,
      notRun: suite.tasks.length - records.length,
      productResults: Object.fromEntries(['passed', 'failed', 'partially_completed', 'correctly_blocked', 'unverified'].map((status) => [status, records.filter((record) => record.oracle.result === status).length])),
      oracleEvaluationChecks: Object.fromEntries(['passed', 'failed', 'unverified'].map((status) => [status, records.filter((record) => record.oracle.evaluationCheck === status).length])),
    },
    records,
    notes: [
      'These controlled Provider trials measure deterministic Runner/Harness/Tools paths, not real-model task completion quality.',
      'Provider physical usage and cost are unavailable; scripted request counts are not token billing data.',
      'The evaluator files are an overlay on the frozen product commit; their separate fingerprint is recorded.',
    ],
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ output: outputPath, counts: baseline.counts }, null, 2)}\n`);
  if (records.some((record) => record.execution.infrastructureStatus === 'blocked' || record.execution.infrastructureStatus === 'harness_error')) process.exitCode = 1;
}

try {
  run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
