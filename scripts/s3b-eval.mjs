#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFailure, hasS3bLiveRunAcknowledgement, resolveS3bProviderProfile, sanitizeS3bText } from './lib/s3b-provider-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frozenHead = 'd5015136ca9cf9583423361263b5bacba257a385';
const baseSuitePath = join(root, 'docs/reference/rcd-s3a-task-suite-2026-10-17.json');
const extensionPath = join(root, 'docs/reference/rcd-s3b-adapter-extension-2026-10-17.json');
const defaultControlledOutput = join(root, 'docs/reference/rcd-s3b-controlled-baseline-2026-10-17.json');
const defaultRealOutput = join(root, 'docs/reference/rcd-s3b-real-baseline-2026-10-17.json');
const s3aAdapters = new Set(['CODE-01', 'FILE-02', 'DELIV-01', 'MULTI-01']);
const s3bAdapters = new Set(['RETR-01', 'LONG-01', 'LONG-02', 'DELIV-02']);
const liveEligible = new Set(['CODE-01', 'FILE-02', 'DELIV-01', 'MULTI-01']);
const evaluationArtifactPaths = [
  /^docs\/reference\/rcd-s3a-/u,
  /^docs\/reference\/rcd-s3b-/u,
  /^scripts\/s3a-eval\.mjs$/u,
  /^scripts\/s3b-eval\.mjs$/u,
  /^scripts\/lib\/s3b-provider-config\.(?:mjs|d\.mts)$/u,
  /^test\/s3a-task-adapters\.test\.ts$/u,
  /^test\/s3b-/u,
  /^scripts\/README\.md$/u,
  /^docs\/reference\/README\.md$/u,
];
const fingerprintFiles = [
  'docs/reference/rcd-s3a-evaluation-protocol-2026-10-17.md',
  'docs/reference/rcd-s3a-metrics-schema-2026-10-17.json',
  'docs/reference/rcd-s3a-task-suite-2026-10-17.json',
  'docs/reference/rcd-s3b-provider-evaluation-2026-10-17.md',
  'docs/reference/rcd-s3b-metrics-schema-2026-10-17.json',
  'docs/reference/rcd-s3b-adapter-extension-2026-10-17.json',
  'scripts/s3a-eval.mjs',
  'scripts/s3b-eval.mjs',
  'scripts/lib/s3b-provider-config.mjs',
  'scripts/lib/s3b-provider-config.d.mts',
  'test/s3a-task-adapters.test.ts',
  'test/s3b-provider-metering.ts',
  'test/s3b-provider-metering.test.ts',
  'test/s3b-task-adapters.test.ts',
  'test/s3b-live-task-trials.test.ts',
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function gitState() {
  const head = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const statusText = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  const status = statusText.split(/\r?\n/u).filter(Boolean);
  const paths = status.map(entry => entry.slice(3).replaceAll('\\', '/'));
  const committedPaths = head === frozenHead ? [] : git('diff', '--name-only', frozenHead, head).split(/\r?\n/u).filter(Boolean);
  const unclassifiedDirtyPaths = paths.filter(path => !evaluationArtifactPaths.some(pattern => pattern.test(path)));
  const unclassifiedCommittedPaths = committedPaths.filter(path => !evaluationArtifactPaths.some(pattern => pattern.test(path)));
  const evaluatorBytes = fingerprintFiles.map(path => {
    try { return `${path}\0${readFileSync(join(root, path))}`; }
    catch { return `${path}\0unreadable`; }
  }).join('\0');
  const diff = git('diff', '--binary', 'HEAD');
  return {
    head,
    committedTree: tree,
    status,
    dirtyPaths: paths,
    unclassifiedDirtyPaths,
    unclassifiedCommittedPaths,
    productSourceDirty: unclassifiedDirtyPaths.length > 0 || unclassifiedCommittedPaths.length > 0,
    trackedDiffSha256: sha256(diff),
    evaluatorFingerprint: sha256(evaluatorBytes),
    workingTreeFingerprint: sha256(`${tree}\0${diff}\0${evaluatorBytes}`),
  };
}

function environment() {
  let pnpm = 'unavailable';
  try { pnpm = execFileSync('pnpm --version', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true }).trim(); }
  catch { /* Preserve unavailable explicitly. */ }
  const packageJson = readJson(join(root, 'package.json'));
  const appPackage = readJson(join(root, 'packages/app/package.json'));
  let electron = appPackage.devDependencies?.electron ?? appPackage.dependencies?.electron ?? packageJson.devDependencies?.electron ?? null;
  try { electron = readJson(join(root, 'node_modules/electron/package.json')).version; } catch { /* Keep declared version/range. */ }
  return {
    os: `${process.platform} ${process.getSystemVersion?.() ?? ''}`.trim(),
    arch: process.arch,
    node: process.version,
    pnpm,
    electron,
    electronBinaryAvailable: existsSync(join(root, 'node_modules/electron/dist/electron.exe')),
    lockfileSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
  };
}

function validateSuites() {
  const suite = readJson(baseSuitePath);
  const extension = readJson(extensionPath);
  const ids = new Set(suite.tasks.map(task => task.id));
  const extensionIds = extension.tasks.map(task => task.id);
  const allIds = [...s3aAdapters, ...extensionIds];
  const duplicateExtensionIds = extensionIds.filter((id, index) => extensionIds.indexOf(id) !== index);
  const mismatch = extension.tasks.filter(task => !ids.has(task.id));
  const errors = [];
  if (suite.tasks.length !== 12) errors.push(`expected 12 S3A definitions, found ${suite.tasks.length}`);
  if (new Set(allIds).size !== 8) errors.push(`expected eight distinct executable adapters, found ${new Set(allIds).size}`);
  if (duplicateExtensionIds.length) errors.push(`duplicate extension IDs: ${duplicateExtensionIds.join(', ')}`);
  if (mismatch.length) errors.push(`extension IDs missing from base suite: ${mismatch.map(task => task.id).join(', ')}`);
  if (extension.baseSuiteSha256 !== sha256(readFileSync(baseSuitePath))) errors.push('base suite hash does not match the S3B adapter extension');
  return { suite, extension, errors };
}

function sanitizeOutput(output, secret) {
  // Shared with the metered Provider boundary so one redaction rule covers the
  // evaluator's stdout/stderr and any Provider-controlled error text.
  return sanitizeS3bText(output, secret);
}

function commandArguments(args) {
  return {
    output: args.find(arg => arg.startsWith('--output='))?.slice('--output='.length),
    task: args.find(arg => arg.startsWith('--task='))?.slice('--task='.length),
    trial: args.find(arg => arg.startsWith('--trial='))?.slice('--trial='.length),
    maxCostUsd: args.find(arg => arg.startsWith('--max-cost-usd='))?.slice('--max-cost-usd='.length),
    maxCostCny: args.find(arg => arg.startsWith('--max-cost-cny='))?.slice('--max-cost-cny='.length),
  };
}

function printUsage() {
  process.stderr.write([
    'Usage:',
    '  node scripts/s3b-eval.mjs --preflight',
    '  node scripts/s3b-eval.mjs --suite',
    '  node scripts/s3b-eval.mjs --verify-provider-metering',
    '  node scripts/s3b-eval.mjs --run-controlled [--task=<ID>] [--output=<path>]',
    '  node scripts/s3b-eval.mjs --run-real --task=<CODE-01|FILE-02|DELIV-01|MULTI-01> --trial=<N> --authorize-live --max-cost-usd=<USD>',
    '  node scripts/s3b-eval.mjs --run-real --task=<CODE-01|FILE-02|DELIV-01|MULTI-01> --trial=<N> --authorize-live --max-cost-cny=<CNY>',
  ].join('\n') + '\n');
}

function runMeteringTest() {
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/s3b-provider-metering.test.ts'], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = sanitizeOutput(`${result.stdout ?? ''}${result.stderr ?? ''}`, process.env.S3B_API_KEY ?? '');
  process.stdout.write(`${JSON.stringify({
    test: 'S3B real Provider metering through local fake HTTP responses',
    externalNetwork: false,
    exitCode: result.status,
    outputSha256: sha256(output),
    output,
  }, null, 2)}\n`);
  if (result.status !== 0) process.exitCode = 1;
}

function checkLiveAuthorization(profile, args) {
  if (!hasS3bLiveRunAcknowledgement(process.env)) throw new Error('Missing S3B_REAL_PROVIDER_AUTHORIZED acknowledgement.');
  if (!args.includes('--authorize-live')) throw new Error('Missing --authorize-live guard. This is a software guard and does not replace direct user authorization.');
  // Same profile resolution and same wire-model mapping as `--preflight`: a
  // deterministic configuration error stops the task entry before any Provider
  // request, retry or budget increment.
  if (profile.state === 'configuration_error' || !profile.ready || !profile.credentials || profile.provider.modelMapping.status !== 'resolved') {
    throw new Error(`S3B deterministic configuration error; refusing before any Provider request: ${(profile.configurationErrors ?? profile.missing).join('; ')}`);
  }
  const budget = commandArguments(args);
  const trial = Number(budget.trial);
  const hasUsdBudget = budget.maxCostUsd !== undefined;
  const hasCnyBudget = budget.maxCostCny !== undefined;
  if (hasUsdBudget === hasCnyBudget) throw new Error('Specify exactly one of --max-cost-usd or --max-cost-cny.');
  const costBudgetCurrency = hasUsdBudget ? 'USD' : 'CNY';
  const maxCost = Number(hasUsdBudget ? budget.maxCostUsd : budget.maxCostCny);
  if (!Number.isSafeInteger(trial) || trial < 1 || trial > 3) throw new Error('--trial must be an integer from 1 to 3.');
  if (costBudgetCurrency !== profile.provider.costBudgetCurrency || !Number.isFinite(maxCost) || maxCost !== profile.provider.costBudgetAmount) {
    throw new Error(`--max-cost-${costBudgetCurrency.toLowerCase()} must exactly match the configured S3B cost budget.`);
  }
  if (args.includes('--run-real') && !liveEligible.has(budget.task)) throw new Error('Real Provider trials are limited to the original four S3A tasks.');
  return { task: budget.task, trial, maxCost, costBudgetCurrency };
}

function observationStatus(record) {
  return record?.observation ?? {};
}

// Failure attribution lives in ./lib/s3b-provider-config.mjs so the ledger
// classifier is unit-testable without executing this CLI entry point, and so the
// "failed Oracle + matching artifact" case can no longer assert an artifact
// failure its own details contradict.


function normalizeRecord({ taskId, trial, tier, sourceBefore, sourceAfter, task, observation, infrastructureStatus, childOutput, startedAt, durationMs, error, childSignal, childExitCode, childSpawnErrorCode, cleanup, providerFallback }) {
  const runtime = observationStatus({ observation });
  const oracle = runtime.oracle ?? { result: 'unverified', evaluationCheck: 'unverified', method: 'Oracle did not report an outcome', evidence: [] };
  const taskResult = oracle.taskResult ?? oracle.result ?? 'unverified';
  const usage = runtime.usage ?? runtime.providerUsage ?? { status: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null, source: null, reason: 'no physical Provider usage receipt' };
  const realProvider = tier === 'B_real_model';
  const provider = runtime.provider ?? providerFallback;
  const physicalProviderRequests = runtime.physicalProviderRequests ?? (realProvider ? null : 0);
  const sourceStable = sourceBefore.head === sourceAfter.head && sourceBefore.workingTreeFingerprint === sourceAfter.workingTreeFingerprint;
  const finalInfrastructureStatus = !cleanup.succeeded || !sourceStable ? 'harness_error' : infrastructureStatus;
  const evidenceRefs = (oracle.evidence ?? []).map(item => typeof item === 'string' ? item : `fixture://${item.path ?? item.ref ?? 'evidence'}`);
  const runtimeSegmentCount = runtime.segmentsObserved ?? runtime.continuationSegments ?? null;
  const providerLimits = provider?.limits ?? {};
  const liveCostArgument = providerLimits.costBudgetCurrency === 'CNY'
    ? `--max-cost-cny=${providerLimits.userApprovedMaxCostCny}`
    : `--max-cost-usd=${providerLimits.userApprovedMaxCostUsd}`;
  const attribution = classifyFailure({ infrastructureStatus: finalInfrastructureStatus, oracle: { ...oracle, result: taskResult }, observation: runtime });
  return {
    schemaVersion: 1,
    recordId: `s3b-${Date.now()}-${taskId.toLowerCase()}-${trial}`,
    taskId,
    trial,
    evidenceTier: tier,
    source: {
      productHead: sourceBefore.head,
      productTreeFingerprint: sourceBefore.committedTree,
      frozenProductHead: frozenHead,
      evaluatorFingerprint: sourceBefore.evaluatorFingerprint,
      workingTreeFingerprint: sourceBefore.workingTreeFingerprint,
      dirty: sourceBefore.status.length > 0,
      dirtyPaths: sourceBefore.dirtyPaths,
      productSourceDirty: sourceBefore.productSourceDirty,
      unclassifiedDirtyPaths: sourceBefore.unclassifiedDirtyPaths,
      unclassifiedCommittedPaths: sourceBefore.unclassifiedCommittedPaths,
      fingerprintStableDuringTrial: sourceStable,
    },
    environment: {
      ...environment(),
      taskDefinitionSha256: sha256(JSON.stringify(task)),
      configSha256: sha256(JSON.stringify({
        taskId,
        tier,
        permissionPreset: 'workspace-write',
        web: taskId === 'RETR-01' ? 'loopback fixture only' : 'disabled',
        provider: realProvider ? provider : { type: 'scripted', simulated: true },
        physicalRequestBudget: realProvider ? provider?.limits?.physicalRequestBudget ?? null : 0,
        outputTokenLimit: realProvider ? provider?.limits?.outputTokenLimit ?? null : null,
        timeoutMs: realProvider ? provider?.timeoutSeconds ?? 120 : 120_000,
      })),
      evaluatorCommand: realProvider
        ? `node scripts/s3b-eval.mjs --run-real --task=${taskId} --trial=${trial} --authorize-live ${liveCostArgument}`
        : `node scripts/s3b-eval.mjs --run-controlled --task=${taskId}`,
    },
    provider: {
      kind: realProvider ? 'real' : 'scripted',
      simulated: !realProvider,
      id: provider?.id ?? null,
      model: provider?.model ?? null,
      apiProtocol: provider?.apiProtocol ?? null,
      endpointOrigin: provider?.endpointOrigin ?? null,
      modelVersion: provider?.modelVersion ?? null,
      parameters: provider?.parameters ?? { temperature: null, topP: null, seed: null },
      limits: provider?.limits ?? null,
      physicalUsageSource: usage.source ?? null,
    },
    execution: {
      infrastructureStatus: finalInfrastructureStatus,
      runtimeStatus: runtime.runtimeStatus ?? null,
      runtimeFinalStatus: runtime.runtimeFinalStatus ?? null,
      runId: runtime.runId ?? null,
      executionLayer: runtime.executionLayer ?? 'not recorded',
      startedAt: runtime.startedAt ?? startedAt,
      endedAt: runtime.endedAt ?? new Date().toISOString(),
      durationMs: runtime.elapsedMs ?? durationMs,
      logicalModelRequests: runtime.logicalModelRequests ?? runtime.modelRequests ?? null,
      logicalEmbeddingRequests: runtime.logicalEmbeddingRequests ?? 0,
      physicalProviderRequests,
      blockedPhysicalRequests: runtime.blockedPhysicalRequests ?? 0,
      toolCallProposals: runtime.toolCallProposals ?? null,
      toolExecutions: runtime.toolExecutions ?? runtime.actualToolExecutions ?? null,
      deniedToolCalls: runtime.deniedToolCalls ?? null,
      failedToolCalls: runtime.failedToolCalls ?? null,
      settledEffects: runtime.settledEffects ?? null,
      unknownEffects: runtime.unknownEffects ?? null,
      segments: runtimeSegmentCount,
      contextCompactions: null,
      usage: {
        status: usage.status ?? 'unavailable',
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cachedInputTokens: usage.cachedInputTokens ?? null,
        source: usage.source ?? null,
        reason: usage.reason ?? null,
        responseCount: usage.responseCount ?? null,
      },
      cost: runtime.cost ?? { status: 'unavailable', value: null, source: null, reason: 'No authoritative Provider billing receipt; token prices were not inferred' },
      network: runtime.network ?? { providerHttpRequests: physicalProviderRequests, agentWebRequests: null, forbiddenRequests: null },
      approvals: runtime.approvals ?? { count: null, source: null },
      invocationEvidence: runtime.invocationEvidence ?? [],
      effectEvidence: runtime.effectEvidence ?? [],
      modelResponseModels: provider?.modelVersion ?? null,
      providerHttpResponses: provider?.httpResponses ?? [],
      runtimeFailure: runtime.runtimeException ?? null,
      childSignal: childSignal ?? null,
      childExitCode: childExitCode ?? null,
      childSpawnErrorCode: childSpawnErrorCode ?? null,
      outputDigests: { childOutputSha256: sha256(childOutput ?? ''), taskObservationSha256: sha256(JSON.stringify(runtime)) },
      error,
    },
    oracle: {
      result: ['passed', 'failed', 'partially_completed', 'correctly_blocked', 'unverified'].includes(taskResult) ? taskResult : 'unverified',
      evaluationCheck: oracle.evaluationCheck ?? oracle.status ?? 'unverified',
      method: oracle.method ?? 'not recorded',
      evidenceRefs,
      falseCompletionClaim: oracle.falseCompletionClaim ?? null,
      details: oracle,
    },
    failureAttribution: attribution ? {
      // The frozen S3B metrics schema keeps this object at
      // `additionalProperties: false`, so the explanatory reason is recorded at
      // the record root (which allows additional properties) instead of inside it.
      primary: attribution.primary,
      secondary: attribution.secondary,
      evidenceRefs: attribution.evidenceRefs,
      confidence: attribution.confidence,
    } : null,
    failureAttributionReason: attribution?.reason ?? null,
    cleanup,
  };
}

function executeTask({ taskId, trial = 1, tier, outputPath }) {
  const { suite, extension, errors: suiteErrors } = validateSuites();
  if (suiteErrors.length) throw new Error(suiteErrors.join('\n'));
  const task = suite.tasks.find(item => item.id === taskId);
  const adapter = extension.tasks.find(item => item.id === taskId);
  if (!task || (!s3aAdapters.has(taskId) && !s3bAdapters.has(taskId))) throw new Error(`Task ${taskId} has no S3B adapter.`);
  if (tier === 'B_real_model' && (!liveEligible.has(taskId) || adapter?.realProviderTrialEligible !== true)) throw new Error(`Task ${taskId} is not eligible for the first real Provider trials.`);

  const sourceBefore = gitState();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const taskRoot = join(tmpdir(), `ls-s3b-${process.pid}-${Date.now()}-${taskId.toLowerCase()}-${trial}`);
  const observationPath = `${taskRoot}.observation.json`;
  const baseTemp = resolve(tmpdir());
  if (!resolve(taskRoot).startsWith(`${baseTemp}${sep}`)) throw new Error('Evaluation temp path escaped the system temp directory.');
  mkdirSync(taskRoot, { recursive: true });
  const isS3aAdapter = s3aAdapters.has(taskId);
  const testPath = tier === 'B_real_model'
    ? 'test/s3b-live-task-trials.test.ts'
    : isS3aAdapter ? 'test/s3a-task-adapters.test.ts' : 'test/s3b-task-adapters.test.ts';
  const testTitle = tier === 'B_real_model' ? `S3B real ${taskId}` : `${isS3aAdapter ? 'S3A' : 'S3B'} ${taskId}`;
  const env = {
    ...process.env,
    S3B_TASK_ID: taskId,
    S3B_TASK_ROOT: taskRoot,
    S3B_OBSERVATION_PATH: observationPath,
    S3B_PROVIDER_MODE: tier === 'B_real_model' ? 'real' : 'controlled',
    ...(isS3aAdapter ? { S3A_TASK_ID: taskId, S3A_TASK_ROOT: taskRoot, S3A_OBSERVATION_PATH: observationPath } : {}),
  };
  const testTimeoutMs = taskId === 'LONG-02' ? 360_000 : tier === 'B_real_model' ? 360_000 : 180_000;
  const child = spawnSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', testPath, '-t', testTitle,
  ], { cwd: root, env, encoding: 'utf8', timeout: testTimeoutMs, maxBuffer: 8 * 1024 * 1024 });
  const childOutput = sanitizeOutput(`${child.stdout ?? ''}${child.stderr ?? ''}`, process.env.S3B_API_KEY ?? '');
  let observation;
  if (existsSync(observationPath)) {
    try { observation = readJson(observationPath); } catch { observation = undefined; }
  }
  let cleanup = { attempted: true, succeeded: false, residuals: [] };
  try {
    rmSync(taskRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rmSync(observationPath, { force: true, maxRetries: 3, retryDelay: 100 });
    const residuals = [taskRoot, observationPath].filter(existsSync);
    cleanup = { attempted: true, succeeded: residuals.length === 0, residuals };
  } catch {
    cleanup = { attempted: true, succeeded: false, residuals: [taskRoot, observationPath].filter(existsSync) };
  }
  const sourceAfter = gitState();
  const infrastructureStatus = child.error?.code === 'ETIMEDOUT'
    ? 'blocked'
    : child.status === 0 && observation
      ? 'executed'
      : 'harness_error';
  const error = child.error ? child.error.code ?? child.error.name : child.status === 0 ? null : `child_exit_${String(child.status)}`;
  const record = normalizeRecord({
    taskId, trial, tier, sourceBefore, sourceAfter, task, observation: observation?.observation ?? {},
    infrastructureStatus, childOutput, startedAt, durationMs: Date.now() - started, error,
    childSignal: child.signal, childExitCode: child.status, childSpawnErrorCode: child.error?.code ?? null, cleanup,
    providerFallback: tier === 'B_real_model'
      ? { id: process.env.S3B_PROVIDER_ID ?? null, model: process.env.S3B_MODEL ?? null, apiProtocol: process.env.S3B_API_PROTOCOL ?? null, endpointOrigin: null }
      : { id: 'scripted', model: null, apiProtocol: null, endpointOrigin: null },
  });
  record.environment.evaluatorCommand = tier === 'B_real_model'
    ? `node scripts/s3b-eval.mjs --run-real --task=${taskId} --trial=${trial}`
    : `node scripts/s3b-eval.mjs --run-controlled --task=${taskId}`;
  return record;
}

function writeLedger(outputPath, { tier, records, selection }) {
  const results = ['passed', 'failed', 'partially_completed', 'correctly_blocked', 'unverified'];
  const infrastructure = ['executed', 'blocked', 'harness_error', 'not_run'];
  const sumWhenComplete = key => records.every(record => Number.isSafeInteger(record.execution[key]) && record.execution[key] >= 0)
    ? records.reduce((sum, record) => sum + record.execution[key], 0)
    : null;
  const ledger = {
    schemaVersion: 1,
    suiteId: 'LS-RCD-S3B-REAL-TASKS-12',
    generatedAt: new Date().toISOString(),
    productStatus: tier === 'B_real_model' ? 'live_trials_authorized_and_executed' : 'controlled_only_real_provider_pending',
    evidenceTier: tier,
    frozenProductHead: frozenHead,
    selection,
    counts: {
      taskDefinitions: 12,
      executableAdapters: 8,
      executed: records.filter(record => record.execution.infrastructureStatus === 'executed').length,
      blocked: records.filter(record => record.execution.infrastructureStatus === 'blocked').length,
      harnessError: records.filter(record => record.execution.infrastructureStatus === 'harness_error').length,
      notRun: 12 - new Set(records.map(record => record.taskId)).size,
      taskResults: Object.fromEntries(results.map(result => [result, records.filter(record => record.oracle.result === result).length])),
      infrastructureStatus: Object.fromEntries(infrastructure.map(status => [status, records.filter(record => record.execution.infrastructureStatus === status).length])),
      logicalModelRequests: sumWhenComplete('logicalModelRequests'),
      physicalProviderRequests: records.every(record => record.execution.physicalProviderRequests !== null) ? records.reduce((sum, record) => sum + record.execution.physicalProviderRequests, 0) : null,
      toolCallProposals: sumWhenComplete('toolCallProposals'),
      toolExecutions: sumWhenComplete('toolExecutions'),
      unavailableUsageTrials: records.filter(record => record.execution.usage.status === 'unavailable').length,
      unavailableCostTrials: records.filter(record => record.execution.cost.status === 'unavailable').length,
      cleanupFailures: records.filter(record => !record.cleanup.succeeded).length,
      failureAttributions: Object.fromEntries([...new Set(records.map(record => record.failureAttribution?.primary).filter(Boolean))].map(primary => [primary, records.filter(record => record.failureAttribution?.primary === primary).length])),
    },
    suiteSha256: sha256(readFileSync(baseSuitePath)),
    adapterExtensionSha256: sha256(readFileSync(extensionPath)),
    metricsSchemaSha256: sha256(readFileSync(join(root, 'docs/reference/rcd-s3b-metrics-schema-2026-10-17.json'))),
    records,
    notes: tier === 'B_real_model'
      ? ['Only the original four S3A tasks are eligible for live trials.', 'Task result comes from the frozen independent Oracle; Provider final text is not a success signal.', 'This trial count is not a population-level success estimate.']
      : ['Controlled Provider runs validate Runtime/evaluator wiring only, not model-selected task quality.', 'Real Provider trials remain real_provider_pending until directly authorized with explicit budgets.', 'Provider usage/cost are unavailable when no authoritative receipts exist.'],
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return ledger;
}

function main(args) {
  const modes = ['--preflight', '--suite', '--verify-provider-metering', '--run-controlled', '--run-real'].filter(flag => args.includes(flag));
  if (modes.length !== 1) { printUsage(); process.exitCode = 2; return; }
  const mode = modes[0];
  const command = commandArguments(args);
  const providerProfile = resolveS3bProviderProfile(process.env);

  if (mode === '--preflight') {
    const { provider, ready, missing, configurationErrors, state, deterministicFailure, authorizationPending } = providerProfile;
    process.stdout.write(`${JSON.stringify({
      state: ready ? 'ready_for_user_authorization' : 'configuration_error',
      realProviderStatus: 'real_provider_pending',
      provider: { ready, missing, configurationErrors, state, deterministicFailure, ...provider },
      liveRunAcknowledgementPresent: hasS3bLiveRunAcknowledgement(process.env),
      authorizationPending,
      deterministicConfigurationError: deterministicFailure,
      liveCallsMade: false,
      note: 'Preflight makes no Provider request. Deterministic configuration errors exit non-zero before any network path; direct user authorization remains a separate gate.',
    }, null, 2)}\n`);
    if (!ready) process.exitCode = 1;
    return;
  }
  if (mode === '--suite') {
    const { suite, extension, errors } = validateSuites();
    if (errors.length) throw new Error(errors.join('\n'));
    process.stdout.write(`${JSON.stringify({ suiteId: suite.suiteId, taskDefinitions: suite.tasks.length, executableAdapters: [...s3aAdapters, ...s3bAdapters], adapterCount: s3aAdapters.size + s3bAdapters.size, s3aTaskSuiteSha256: sha256(readFileSync(baseSuitePath)), extensionSha256: sha256(readFileSync(extensionPath)), realProviderEligibleTasks: [...liveEligible], realProviderStatus: 'real_provider_pending' }, null, 2)}\n`);
    return;
  }
  if (mode === '--verify-provider-metering') { runMeteringTest(); return; }

  let tier;
  let selected;
  let outputPath;
  if (mode === '--run-controlled') {
    const { suite, extension, errors } = validateSuites();
    if (errors.length) throw new Error(errors.join('\n'));
    tier = 'A_runtime_deterministic';
    selected = command.task ? [command.task] : [...s3aAdapters, ...extension.tasks.filter(task => s3bAdapters.has(task.id)).map(task => task.id)];
    if (selected.some(id => !s3aAdapters.has(id) && !s3bAdapters.has(id))) throw new Error('Controlled task selection contains an ID without an executable adapter.');
    outputPath = resolve(command.output ?? defaultControlledOutput);
  } else {
    const authorized = checkLiveAuthorization(providerProfile, args);
    tier = 'B_real_model';
    selected = [authorized.task];
    outputPath = resolve(command.output ?? defaultRealOutput);
  }

  const trial = Number(command.trial ?? 1);
  const records = selected.map(taskId => executeTask({ taskId, trial, tier }));
  const ledger = writeLedger(outputPath, { tier, records, selection: { mode, taskIds: selected, trial } });
  process.stdout.write(`${JSON.stringify({ output: outputPath, evidenceTier: tier, counts: ledger.counts }, null, 2)}\n`);
  if (ledger.counts.harnessError > 0 || ledger.counts.blocked > 0 || ledger.counts.cleanupFailures > 0) process.exitCode = 1;
}

try { main(process.argv.slice(2)); }
catch (error) {
  // Never print provider-controlled error text, endpoint paths, or credentials.
  const message = error instanceof Error ? error.message : 'unknown evaluator failure';
  const sanitized = sanitizeOutput(message, process.env.S3B_API_KEY ?? '');
  process.stderr.write(`${sanitized}\n`);
  process.exitCode = 1;
}
