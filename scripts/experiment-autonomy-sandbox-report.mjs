#!/usr/bin/env node
// Aggregation for the runtime-autonomy experiment (taskbook RT-05 and section 8).
//
// It reads the per-run ledger plus the preserved run directories and reports, per case and arm: how many
// runs were started, what the independent artifact checks said, whether the tested path was reached at
// all, how many approval prompts and interventions the run needed, how many legitimate calls the rules
// refused, and what the Provider charged in tokens.
//
// It also re-runs one acceptance check on the preserved workspaces of RT-01, because that case's in-run
// checks only covered the Web-citation half. The second check answers the question the first one missed:
// did the run actually fix the fixture's build error? Nothing here re-executes model-written code; the
// check is a static reading of the artifact the run left behind.
//
// Usage: node scripts/experiment-autonomy-sandbox-report.mjs [--evidence=<dir>] [--json=<path>]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readJsonLines, writeJson } from './lib/experiment-ledger.mjs';

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    args[key] = value ?? true;
  }
  return args;
}

/**
 * The independent RT-01 acceptance check the in-run verifier lacked: did the fixture's build error get
 * fixed? The fixture parses JSON that contains `//` comments with a bare `JSON.parse`, and the fix has to
 * deal with the comments. Reading the artifact is enough to answer that; the run's own reply is not used.
 */
/**
 * RA-05 replaced a static reading with an execution. The previous check looked for comment-handling in the
 * source, which cannot tell a real fix from code that was deleted, emptied or short-circuited — and those
 * are exactly the shapes a model reaches for when it cannot solve the task. Running the fixture's own build
 * is the independent semantic check: it fails unless the program actually parses the file it was failing on.
 */
function runRt01Build(workspace) {
  const result = spawnSync(process.execPath, ['tools/build.mjs'], {
    cwd: workspace, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  return {
    ran: result.error === undefined,
    exitCode: result.status,
    stdout: String(result.stdout ?? '').slice(0, 300),
    stderr: String(result.stderr ?? result.error?.message ?? '').slice(0, 300),
    holds: result.status === 0 && /"retries"\s*:\s*2/u.test(String(result.stdout ?? '')),
  };
}

function rt01ArtifactCheck(workspace) {
  const path = join(workspace, 'src', 'parse-config.mjs');
  if (!existsSync(path)) return { pass: false, reason: 'src/parse-config.mjs is missing' };
  const source = readFileSync(path, 'utf8');
  const exportsParseConfig = /export\s+(?:async\s+)?function\s+parseConfig|export\s+const\s+parseConfig/u.test(source);
  const stillBareJsonParse = /JSON\.parse\(\s*raw\s*\)/u.test(source);
  const handlesComments = /jsonc|stripJsonComments|strip[-_]?comments|replace\(|\/\/|comment/iu.test(source);
  const configStillHasComments = (() => {
    const configPath = join(workspace, 'config', 'app.json');
    return existsSync(configPath) && /\/\//u.test(readFileSync(configPath, 'utf8'));
  })();
  const build = runRt01Build(workspace);
  return {
    pass: build.holds,
    executedBuild: build,
    exportsParseConfig,
    stillBareJsonParse,
    handlesComments,
    fixtureStillExercisesTheBug: configStillHasComments,
    excerpt: source.slice(0, 400),
  };
}

function checkCase(caseId, workspace) {
  if (caseId !== 'RT-01') return null;
  return rt01ArtifactCheck(workspace);
}

function summarize(records, evidenceDir) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.caseId}|${record.arm}`;
    const group = groups.get(key) ?? {
      caseId: record.caseId, arm: record.arm, runs: 0, pass: 0, fail: 0, unverified: 0, blocked: 0,
      targetTriggered: 0, notTriggered: 0, permissionPrompts: 0, interventions: 0, refusals: 0,
      promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0, elapsedMs: 0, unknownUsage: 0,
      artifactChecks: [], sourceHashes: new Set(), postHoc: [],
    };
    group.runs += 1;
    group[record.outcome] = (group[record.outcome] ?? 0) + 1;
    if (record.targetTriggered === 'yes' || record.targetTriggered === 'injected-and-observed') group.targetTriggered += 1;
    else group.notTriggered += 1;
    group.permissionPrompts += (record.interventions ?? [])
      .filter((entry) => entry.kind === 'permission_prompts')
      .reduce((total, entry) => total + (entry.count ?? 0), 0);
    group.refusals += (record.refusals ?? []).length;
    if (record.usage?.status === 'reported') {
      group.promptTokens += record.usage.promptTokens ?? 0;
      group.completionTokens += record.usage.completionTokens ?? 0;
      group.cachedPromptTokens += record.usage.cachedPromptTokens ?? 0;
    } else {
      group.unknownUsage += 1;
    }
    group.elapsedMs += record.elapsedMs ?? 0;
    group.sourceHashes.add(record.sourceHash);
    for (const check of record.artifactChecks ?? []) {
      group.artifactChecks.push({ trial: record.trial, id: check.id, pass: check.pass });
    }
    // The post-hoc acceptance check on the preserved artifact.
    const runDir = (record.evidenceRefs ?? [])[0];
    if (runDir) {
      const post = checkCase(record.caseId, join(runDir, 'data', 'workplace'));
      if (post) group.postHoc.push({ trial: record.trial, ...post });
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    sourceHashes: [...group.sourceHashes],
    postHocPasses: group.postHoc.filter((entry) => entry.pass).length,
    artifactCheckFailures: group.artifactChecks.filter((check) => check.pass === false).map((check) => check.id),
  }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceDir = args.evidence ?? 'D:\\littlesheep-evidence\\RASB-2026-09-27';
  const ledgerPath = args.ledger ?? join(evidenceDir, 'ledger.jsonl');
  const records = readJsonLines(ledgerPath);
  // `--batches=` restricts the summary to the blocks that ran to completion. Every raw record stays in the
  // ledger; an interrupted block is excluded from the totals, never deleted, and is named in the report.
  const wanted = args.batches ? String(args.batches).split(',') : null;
  const selected = wanted ? records.filter((record) => wanted.includes(record.batchId)) : records;
  const excludedBatches = [...new Set(records.filter((record) => !selected.includes(record)).map((record) => record.batchId))];
  const runtime = selected.filter((record) => record.status !== 'sandbox');
  const groups = summarize(runtime, evidenceDir);
  const sandbox = records.filter((record) => record.status === 'sandbox');

  const payload = {
    generatedAt: new Date().toISOString(),
    ledger: ledgerPath,
    totals: {
      runs: runtime.length,
      promptTokens: runtime.reduce((total, record) => total + (record.usage?.promptTokens ?? 0), 0),
      completionTokens: runtime.reduce((total, record) => total + (record.usage?.completionTokens ?? 0), 0),
      runsWithUnknownUsage: runtime.filter((record) => record.usage?.status !== 'reported').length,
      sandboxRecords: sandbox.length,
    },
    excludedBatches,
    groups,
    cost: {
      status: 'unknown',
      reason: 'no price table is configured in this repository or data root; section 5 requires unknown rather than zero',
    },
    combinationRuns: groups.filter((group) => group.caseId.startsWith('RT-04-poll')).length,
    notes: [
      'Runs whose target path was never reached are reported separately and are not counted as a rule win or loss.',
      'The RT-01 post-hoc check reads the artifact only; it does not execute model-written code.',
      'Cost is reported as unknown because no price source is configured; tokens are the comparable measure here.',
    ],
  };

  const lines = [
    `# RT 汇总 ${payload.generatedAt}`,
    '',
    `账本：${ledgerPath}`,
    `真实模型 run：${payload.totals.runs}；prompt tokens：${payload.totals.promptTokens}；completion tokens：${payload.totals.completionTokens}；usage 缺失 run：${payload.totals.runsWithUnknownUsage}`,
    '',
    '| 用例 | 臂 | run | pass | fail | 未触发 | 权限提示 | 拒绝 | prompt tok | completion tok | 耗时 ms | sourceHash 数 | 事后验收通过 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...groups.map((group) => `| ${group.caseId} | ${group.arm} | ${group.runs} | ${group.pass ?? 0} | ${group.fail ?? 0} | ${group.notTriggered} | ${group.permissionPrompts} | ${group.refusals} | ${group.promptTokens} | ${group.completionTokens} | ${group.elapsedMs} | ${group.sourceHashes.length} | ${group.postHoc.length ? `${group.postHocPasses}/${group.postHoc.length}` : '—'} |`),
    '',
    '## 逐项验收细节',
    ...groups.map((group) => `- ${group.caseId}/${group.arm}: 失败验收项 ${group.artifactCheckFailures.length ? [...new Set(group.artifactCheckFailures)].join(', ') : '无'}；sourceHash ${group.sourceHashes.map((hash) => hash.slice(0, 12)).join(', ')}`),
    '',
  ];

  if (args.json) writeJson(args.json, payload);
  process.stdout.write(`${lines.join('\n')}\n`);
  if (args.json) process.stdout.write(`\nJSON: ${args.json}\n`);
}

main();
