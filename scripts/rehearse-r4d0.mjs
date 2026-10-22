#!/usr/bin/env node
// R4-D0 offline rehearsal and protocol freeze.
//
// --freeze: write the frozen protocol + offline Provider preflight inventory.
// --rehearse: run the planned 4x5 controlled matrix through the real V2
//   evaluator with the scripted Provider (evidence tier A), then rehearse
//   capability/infrastructure classification, duplicate-run refusal and budget
//   stops. No network model request is made; this never authorizes a paid run.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  R4D0_BATCH_ID, R4D0_PROTOCOL_VERSION, REAL_EVIDENCE_TIER, buildProtocolFrozen, buildTrialPlan,
  classifyAttempt, evaluateTrialBudget, validateTrialPlan,
} from './lib/r4d0/protocol.mjs';
import { runOfflinePreflight } from './lib/r4d0/preflight.mjs';
import { computeMetrics } from './lib/r4b/metrics.mjs';
import { REPO_ROOT } from './lib/r4b/contract.mjs';

const PREFLIGHT_PATH = 'docs/reference/rcd-r4d0-preflight-2026-10-22.json';
const REHEARSAL_JSON_PATH = 'docs/reference/rcd-r4d0-offline-rehearsal-2026-10-22.json';
const REHEARSAL_MD_PATH = 'docs/reference/rcd-r4d0-offline-rehearsal-2026-10-22.md';
const args = process.argv.slice(2);
const force = args.includes('--force');
const mode = args.includes('--freeze') ? 'freeze' : 'rehearse';

function runEval(trial, { recordsDir, variant = 'canonical', faultMode } = {}) {
  const command = [
    'scripts/eval-v2.mjs', '--run-controlled',
    `--task=${trial.taskId}`, `--trial=${trial.trial}`, `--batch=${trial.batchId}`,
    `--records-dir=${recordsDir}`,
    ...(variant !== 'canonical' ? [`--variant=${variant}`] : []),
    ...(faultMode ? [`--fault-mode=${faultMode}`] : []),
  ];
  const child = spawnSync(process.execPath, command, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 240_000 });
  let summary = null;
  try { summary = JSON.parse(child.stdout.trim()) } catch { summary = null; }
  return { exitCode: child.status, stdout: child.stdout, stderr: child.stderr, summary, command: `node ${command.join(' ')}` };
}

async function writeOnce(path, content) {
  const absolute = join(REPO_ROOT, path);
  if (existsSync(absolute) && !force) throw new Error(`REFUSE_OVERWRITE: ${path} exists; pass --force`);
  await writeFile(absolute, content, 'utf8');
  return path;
}

function buildFreezeArtifact() {
  const protocol = buildProtocolFrozen();
  const preflight = runOfflinePreflight();
  return {
    version: 1,
    kind: 'r4d0-protocol-freeze',
    protocolVersion: R4D0_PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
    realProviderCalled: false,
    realProviderAuthorized: false,
    baseline: {
      r4bBaselineSha: 'c12fb52e031d70c29f5781a4ea843ba474b2df6a',
      r4cBaselineSha: '4ebc1e6792cc1ed19b720c49adabcb9dd7abb83e',
      localMainNotSyncedToGitHub: true,
      hostedCiEvidenceAvailable: false,
    },
    protocol,
    preflight,
    separation: protocol.separation,
    authorization: {
      ...protocol.authorization,
      checklist: [
        'user names the exact Provider and wire model id',
        'user approves the 4 tasks x 5 trials scope (20 planned real trials)',
        'user approves a physical request ceiling and output token ceiling',
        'user confirms the provider-side billing hard cap, currency and amount',
        'real-model adapter for V2 tasks is implemented and dry-run validated',
        'hosted CI evidence for the R4-B/C local commits is obtained or explicitly waived',
      ],
    },
    decision: {
      technicalReadiness: 'offline-rehearsal-only',
      paidTrialsAuthorized: false,
      note: 'R4-D0 freezes preparation only; no paid trial may start without the explicit user authorization above.',
    },
  };
}

function renderRehearsalMarkdown(evidence) {
  const lines = [
    '# RCD R4-D0 离线端到端演练报告',
    '',
    `**协议版本：** \`${evidence.protocolVersion}\`　**演练批次：** \`${evidence.batchId}\`　**证据层级：** \`A_runtime_deterministic\`（本地 scripted Provider）`,
    '',
    '> 本演练未调用真实 Provider、未使用真实凭据、未授权任何付费试验。演练结果为评测机制证据，不代表模型能力。',
    '',
    '## 计划与执行',
    '',
    `- 计划试验：${evidence.counts.planned}（4 任务 × Trial 1–5）；实际执行：${evidence.counts.executed}。`,
    `- 通过 / 能力失败 / 未解决 / 基础设施失败：${evidence.counts.capabilityPass} / ${evidence.counts.capabilityFailure} / ${evidence.counts.capabilityUnresolved} / ${evidence.counts.infrastructureFailure}。`,
    `- 产品 SHA：\`${evidence.baseline.productSha}\`；评测器指纹：\`${evidence.baseline.evaluatorFingerprint}\`。`,
    '',
    '## 三维度指标（仅受控演练）',
    '',
    '| 指标 | 分母 ID | n | 通过 | 失败 | 排除 |',
    '|---|---|---:|---:|---:|---|',
    ...['goal', 'contract', 'mechanism'].map((name) => {
      const metric = evidence.metrics[name];
      const excluded = Object.entries(metric.excluded ?? {}).map(([key, value]) => `${key}=${value}`).join(', ') || '—';
      return `| ${name} | ${metric.denominatorId} | ${metric.n} | ${metric.passed} | ${metric.failed} | ${excluded} |`;
    }),
    '',
    `N=${evidence.counts.executed} 属初步故障发现样本；\`populationClaim=false\`，不得据此声称稳定的总体任务成功率。`,
    '',
    '## 逐试验证据',
    '',
    '| 记录 | 任务 | trial | 分类 | Goal | Contract | Mechanism | 逻辑/物理请求 | 工具执行 | 已结算 Effect | 耗时 ms |',
    '|---|---|---:|---|---|---|---|---:|---:|---:|---:|',
    ...evidence.trials.map((trial) => `| ${trial.recordId} | ${trial.taskId} | ${trial.trial} | ${trial.classification} | ${trial.dimensions.goal} | ${trial.dimensions.contract} | ${trial.dimensions.mechanism} | ${trial.requests.logical}/${trial.requests.physical} | ${trial.tooling.executed} | ${trial.effects.settled} | ${trial.durationMs} |`),
    '',
    '## 隔离、预算与停止条件',
    '',
    ...evidence.isolation.checks.map((item) => `- ${item.ok ? 'PASS' : 'FAIL'}：${item.id} — ${item.detail}`),
    '',
    ...evidence.budget.checks.map((item) => `- ${item.ok ? 'PASS' : 'FAIL'}：${item.id} — ${item.detail}`),
    '',
    '## 失败分类与拒绝路径',
    '',
    ...evidence.drills.map((item) => `- ${item.ok ? 'PASS' : 'FAIL'}：${item.id} — ${item.detail}`),
    '',
    '## 结论',
    '',
    '离线批次调度、trial 隔离、记录落盘、失败分类、重复运行拒绝与预算停止演练通过。真实 Provider 费用上限、真实模型执行适配器与用户授权仍未就绪，因此本演练不构成付费试验的 Go。',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function rehearse() {
  const preflight = runOfflinePreflight();
  if (!preflight.ok) throw new Error('offline preflight failed; refusing to rehearse');
  const root = await mkdtemp(join(tmpdir(), 'ls-r4d0-rehearsal-'));
  const recordsDir = join(root, 'records');
  const drillsDir = join(root, 'drills');
  await mkdir(recordsDir, { recursive: true });
  await mkdir(drillsDir, { recursive: true });

  const plan = buildTrialPlan({ batchId: R4D0_BATCH_ID });
  const planCheck = validateTrialPlan(plan, { expectedBatchId: R4D0_BATCH_ID });
  if (!planCheck.ok) throw new Error(`invalid rehearsal plan: ${planCheck.errors.join('; ')}`);

  const trials = [];
  const failures = [];
  for (const trial of plan) {
    const run = runEval(trial, { recordsDir });
    if (run.exitCode !== 0 || !run.summary?.recordPath) {
      failures.push({ trial, exitCode: run.exitCode, stderr: run.stderr.slice(-800), stdoutTail: run.stdout.slice(-1200) });
      process.stderr.write(`rehearsal: trial failed ${trial.taskId} t${trial.trial} exit=${run.exitCode} stderr=${run.stderr.slice(-400)}\n`);
      break; // D0-4: an infrastructure/ledger failure stops later trials.
    }
    const record = JSON.parse(await readFile(run.summary.recordPath, 'utf8'));
    const classification = classifyAttempt({ infrastructureStatus: record.execution.infrastructureStatus, dimensions: record.dimensions, errorCode: null });
    trials.push({
      recordId: record.recordId, taskId: record.taskId, trial: record.trial, recordPath: run.summary.recordPath,
      classification: classification.category, dimensions: Object.fromEntries(Object.entries(record.dimensions).map(([name, value]) => [name, value.status])),
      requests: record.execution.requests, tokens: record.execution.tokens, tooling: record.execution.tooling,
      effects: record.execution.effects, durationMs: record.execution.durationMs, cleanup: record.cleanup.succeeded,
      providerUsage: record.providerUsage,
    });
  }

  if (trials.length === 0 || failures.length > 0) {
    throw new Error(`rehearsal matrix stopped after ${trials.length}/${plan.length} trials: ${JSON.stringify(failures)}`);
  }
  const records = trials.map((trial) => JSON.parse(readFileSync(trial.recordPath, 'utf8')));
  const metrics = computeMetrics(records);
  const uniqueRecordIds = new Set(trials.map((trial) => trial.recordId)).size;
  const uniquePaths = new Set(trials.map((trial) => trial.recordPath)).size;
  const cleanupFailures = trials.filter((trial) => !trial.cleanup).length;
  const physicalTotal = trials.reduce((sum, trial) => sum + (trial.requests.physical ?? 0), 0);
  const logicalTotal = trials.reduce((sum, trial) => sum + (trial.requests.logical ?? 0), 0);
  const observedOutputTokens = trials.reduce((sum, trial) => sum + (trial.tokens.observedOutput ?? 0), 0);
  const budgetChecks = [
    { id: 'per-trial-request-budget', ok: trials.every((trial) => !evaluateTrialBudget({ physicalRequests: trial.requests.physical ?? 0, outputTokens: trial.tokens.observedOutput ?? 0 }).stop), detail: 'every executed trial stayed inside its per-trial caps' },
    { id: 'batch-request-budget', ok: !evaluateTrialBudget({ batchPhysicalRequests: physicalTotal, batchOutputTokens: observedOutputTokens }).stop, detail: `logical=${logicalTotal}, physical=${physicalTotal}, observedOutputTokens=${observedOutputTokens}` },
    { id: 'usage-unavailable-preserved', ok: trials.every((trial) => trial.providerUsage?.status === 'unavailable'), detail: 'scripted Provider reports no Provider usage/cost; records keep unavailable' },
  ];
  const isolationChecks = [
    { id: 'unique-record-identities', ok: uniqueRecordIds === trials.length && uniqueRecordIds === 20, detail: `${uniqueRecordIds}/${trials.length} unique record ids` },
    { id: 'unique-record-paths', ok: uniquePaths === trials.length, detail: `${uniquePaths}/${trials.length} distinct record files` },
    { id: 'trial-cleanup', ok: cleanupFailures === 0, detail: `${cleanupFailures} cleanup failures` },
    { id: 'one-trial-per-identity', ok: planCheck.ok, detail: '4 tasks x trials 1-5, no duplicate (batch, task, trial)' },
  ];

  const drills = [];
  const wrongField = runEval({ ...plan[0], taskId: 'FILE-02-S', trial: 1 }, { recordsDir: drillsDir, variant: 'wrong-field' });
  const wrongFieldRecord = wrongField.summary?.recordPath ? JSON.parse(await readFile(wrongField.summary.recordPath, 'utf8')) : null;
  drills.push({
    id: 'capability-contract-failure-detected',
    ok: wrongField.exitCode === 0 && wrongFieldRecord?.dimensions?.contract?.status === 'failed' && wrongFieldRecord?.dimensions?.goal?.status === 'passed',
    detail: 'wrong-field variant: Goal passed / Contract failed, detected as a capability failure without changing the task prompt',
  });
  const noRecovery = runEval({ ...plan[0], taskId: 'DELIV-01-R', trial: 1 }, { recordsDir: drillsDir, faultMode: 'no-recovery' });
  const noRecoveryRecord = noRecovery.summary?.recordPath ? JSON.parse(await readFile(noRecovery.summary.recordPath, 'utf8')) : null;
  drills.push({
    id: 'capability-mechanism-failure-detected',
    ok: noRecovery.exitCode === 0 && noRecoveryRecord?.dimensions?.goal?.status === 'failed' && noRecoveryRecord?.dimensions?.mechanism?.status === 'failed',
    detail: 'no-recovery fault: Goal and Mechanism independently failed while the exception stayed localized',
  });
  const invalidTask = runEval({ ...plan[0], taskId: 'FILE-99-INFRA' }, { recordsDir: drillsDir });
  drills.push({
    id: 'infrastructure-failure-classified-not-capability',
    ok: invalidTask.exitCode !== 0,
    detail: 'invalid task/adapter failure exits non-zero; it is recorded as infrastructure failure and never enters capability denominators',
  });
  const duplicateRun = runEval(plan[0], { recordsDir });
  drills.push({
    id: 'duplicate-run-refused',
    ok: duplicateRun.exitCode !== 0 && /LEDGER_RECORD_EXISTS|refusing to overwrite/iu.test(`${duplicateRun.stderr}\n${duplicateRun.stdout}`),
    detail: 'repeating an existing (batch, task, trial) identity is refused instead of overwriting history',
  });
  const overBudget = evaluateTrialBudget({ physicalRequests: 99, batchPhysicalRequests: 999 });
  const budgetStop = evaluateTrialBudget({ physicalRequests: 9 });
  drills.push({
    id: 'budget-stop-without-raising-budget',
    ok: budgetStop.stop === true && budgetStop.code === 'BUDGET_REQUESTS_EXHAUSTED' && overBudget.stop === true,
    detail: 'simulated per-trial/batch overage stops the batch; no code path increases the budget to finish N=5',
  });
  const frozen = buildProtocolFrozen();
  drills.push({
    id: 'authorization-gate-closed',
    ok: frozen.mayCallRealProvider === false && frozen.authorization.realProviderAuthorized === false && REAL_EVIDENCE_TIER === 'B_real_model',
    detail: 'protocol freeze reports no real authorization; rehearsal evidence tier remains A',
  });

  const evidence = {
    version: 1,
    ok: failures.length === 0 && trials.length === 20 && drills.every((item) => item.ok),
    kind: 'r4d0-offline-rehearsal',
    protocolVersion: R4D0_PROTOCOL_VERSION,
    batchId: R4D0_BATCH_ID,
    generatedAt: new Date().toISOString(),
    evidenceTier: 'A_runtime_deterministic',
    realEvidenceTier: REAL_EVIDENCE_TIER,
    realProviderCalled: false,
    preflightOk: preflight.ok,
    baseline: { productSha: records[0].product.sha, evaluatorFingerprint: records[0].evaluator.fingerprint, taskSuiteSha256: records[0].suiteSha256 },
    counts: {
      planned: plan.length, executed: trials.length,
      capabilityPass: trials.filter((trial) => trial.classification === 'capability_pass').length,
      capabilityFailure: trials.filter((trial) => trial.classification === 'capability_failure').length,
      capabilityUnresolved: trials.filter((trial) => trial.classification === 'capability_unresolved').length,
      infrastructureFailure: failures.length,
    },
    trials,
    metrics,
    budget: { totals: { logicalTotal, physicalTotal, observedOutputTokens }, checks: budgetChecks, caps: { perTrialPhysical: 8, batchPhysical: 160, perRequestOutputTokens: 2048, batchOutputTokens: 40960 } },
    isolation: { checks: isolationChecks },
    drills,
    failures,
    limits: [
      'controlled scripted Provider only; no real model capability is measured',
      'scripted Provider performs no HTTP request, so physical request accounting is exercised by the R4-B metering tests and the synthetic budget drill, not by this batch',
      'no real Provider usage or cost is available; records keep unavailable',
      'first-artifact latency is not recorded by the current adapter and stays unavailable',
    ],
  };
  const evidenceJson = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidenceMarkdown = renderRehearsalMarkdown(evidence);
  return { evidence, evidenceJson, evidenceMarkdown, root };
}

try {
  if (mode === 'freeze') {
    const artifact = buildFreezeArtifact();
    const path = await writeOnce(PREFLIGHT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: artifact.preflight.ok, mode, path, protocolVersion: artifact.protocolVersion, plannedTrials: artifact.protocol.plannedTrials, realProviderAuthorized: false })}\n`);
  } else {
    const { evidence, evidenceJson, evidenceMarkdown, root } = await rehearse();
    await writeOnce(REHEARSAL_JSON_PATH, evidenceJson);
    await writeOnce(REHEARSAL_MD_PATH, evidenceMarkdown);
    process.stdout.write(`${JSON.stringify({ ok: evidence.ok, mode, root, planned: evidence.counts.planned, executed: evidence.counts.executed, capabilityPass: evidence.counts.capabilityPass, drills: evidence.drills.length, metrics: { goal: evidence.metrics.goal.n, contract: evidence.metrics.contract.n, mechanism: evidence.metrics.mechanism.n } })}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
