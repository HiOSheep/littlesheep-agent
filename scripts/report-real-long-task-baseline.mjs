// Aggregate the frozen real-long-task runs into one baseline record.
//
// Reads the per-run reports written by scripts/run-real-long-task.mjs (plus the
// kept isolated data roots for the loss decomposition) and emits the LT-00
// baseline: every run, every frozen node, the measured H_ui, the uncached split
// and the derived bounds. Nothing is averaged into a headline, no failing run is
// dropped, and a run whose usage is incomplete is reported as unavailable.
//
// Usage: node scripts/report-real-long-task-baseline.mjs [--dir .codex_tmp] [--json <path>] [--markdown <path>]
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSessions, readLedger } from './lib/session-cache-ledger.mjs';
import { MANIFEST_VERSION, REAL_LONG_TASKS, validateManifest } from './lib/real-long-task-manifest.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const resultsDir = resolve(repoRoot, valueOf('--dir') ?? '.codex_tmp');
const jsonPath = resolve(repoRoot, valueOf('--json') ?? 'docs/reference/cache-baseline/real-long-task-baseline-2026-09-22.json');
const markdownPath = resolve(repoRoot, valueOf('--markdown') ?? 'docs/reference/cache-baseline/real-long-task-baseline-2026-09-22.md');

function readRuns() {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((name) => /^real-long-task-[A-C][12]-\d+\.json$/u.test(name))
    .map((name) => {
      try {
        return { file: name, report: JSON.parse(readFileSync(join(resultsDir, name), 'utf8')) };
      } catch {
        return undefined;
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.report.taskId.localeCompare(right.report.taskId)
      || left.report.attempt - right.report.attempt);
}

/** Re-read the kept data root so the loss decomposition comes from the same ledger. */
function lossesOf(report) {
  const rootName = report.environment?.rootName;
  if (!rootName) return undefined;
  const dataDir = join(tmpdir(), rootName, 'data');
  if (!existsSync(dataDir)) return undefined;
  const projection = projectSessions(readLedger(dataDir));
  const session = projection.sessions[0];
  return session ? { losses: session.losses, auxiliary: session.auxiliary, unattributed: projection.unattributed } : undefined;
}

function rate(run) {
  return {
    taskId: run.report.taskId,
    attempt: run.report.attempt,
    classId: run.report.classId,
    turnsOk: (run.report.turns ?? []).filter((turn) => turn.ok).length,
    turns: (run.report.turns ?? []).length,
    acceptanceOk: (run.report.acceptance ?? []).filter((check) => check.ok).length,
    acceptance: (run.report.acceptance ?? []).length,
    failedChecks: (run.report.acceptance ?? []).filter((check) => !check.ok)
      .map((check) => `${check.label}${check.detail ? ` (${check.detail.slice(0, 120)})` : ''}`),
    stopReason: run.report.turnStopReason ?? undefined,
    requests: run.report.session?.requests,
    input: run.report.session?.input,
    cached: run.report.session?.cached,
    hitPercent: run.report.session?.hUiPercent,
    requestsWithoutUsage: run.report.ledgerCoverage?.requestsWithoutUsage,
    auxiliaryRequests: run.report.auxiliary?.requests,
    hAllPercent: run.report.all?.hitPercent ?? run.report.session?.hUiPercent,
    nodes: (run.report.nodes ?? []).map((node) => ({
      id: node.id,
      turn: node.turn,
      hitPercent: node.hitPercent,
      withinTarget: node.withinTarget,
      availability: node.availability,
    })),
    conclusion: run.report.conclusion?.nodeConclusion ?? run.report.nodeJudgement?.conclusion,
    losses: lossesOf(run.report)?.losses,
    rootName: run.report.environment?.rootName,
    source: run.file,
  };
}

const manifest = validateManifest();
const runs = readRuns().map((run) => rate(run));
const judged = runs.filter((run) => run.conclusion === 'met');
const complete = runs.filter((run) => run.requestsWithoutUsage === 0);
const aggregate = {
  check: 'real-long-task-baseline',
  recordedAt: new Date().toISOString(),
  manifestVersion: MANIFEST_VERSION,
  manifestValid: manifest.ok,
  manifestErrors: manifest.errors,
  frozenTasks: REAL_LONG_TASKS.map((task) => ({
    id: task.id,
    classId: task.classId,
    title: task.title,
    turns: task.turns.length,
    nodes: task.nodes.map((node) => ({ id: node.id, turn: node.turn, label: node.label })),
  })),
  runs: runs.length,
  expectedRuns: REAL_LONG_TASKS.length * 2,
  usageCompleteRuns: complete.length,
  metRuns: judged.length,
  belowRedLineRuns: runs.length - judged.length,
  runsWithFunctionalFailure: runs.filter((run) => run.turnsOk < run.turns || run.acceptanceOk < run.acceptance).length,
  results: runs,
};

function fmt(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function markdown(data) {
  const lines = [];
  lines.push('# 真实长任务缓存基线（冻结清单，2026-09-22）');
  lines.push('');
  lines.push(`最后更新：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  lines.push('');
  lines.push('本文件由 `scripts/report-real-long-task-baseline.mjs` 从冻结任务清单的每次真实运行报告生成；');
  lines.push('原始报告在 `.codex_tmp/real-long-task-<任务>-<次数>.json`，隔离数据根保留在系统临时目录。');
  lines.push('H_ui 是 DeepSeek Harness 前端的会话累计口径：`ΣcacheRead / Σ(uncachedInput + cacheRead + cacheWrite)`，');
  lines.push('首次冷输入计入分母，压缩等独立调用单列并进入 H_all。判定按精确值，不按显示取整。');
  lines.push('');
  lines.push(`- 冻结清单版本：${data.manifestVersion}，校验：${data.manifestValid ? 'ok' : `失败（${data.manifestErrors.join('; ')}）`}`);
  lines.push(`- 运行：${data.runs}/${data.expectedRuns}（每任务两次）；usage 完整：${data.usageCompleteRuns}/${data.runs}`);
  lines.push(`- 达标（所有冻结节点 ≥95%）：**${data.metRuns}/${data.runs}**；低于红线：${data.belowRedLineRuns}`);
  lines.push(`- 存在功能失败（回合或产物验收未通过）：${data.runsWithFunctionalFailure}/${data.runs}`);
  lines.push('');
  lines.push('## 逐次运行');
  lines.push('');
  lines.push('| 任务 | 次数 | 回合 | 产物验收 | 请求 | 输入 | 缓存 | H_ui | 节点 H_ui | 未缓存拆分（冷启动/重建/尾部） | 结论 |');
  lines.push('| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |');
  for (const run of data.results) {
    const nodeText = run.nodes.map((node) => `${node.id} ${fmt(node.hitPercent, 1)}%`).join('<br>');
    const losses = run.losses;
    const lossText = losses
      ? `${losses.coldStart}/${losses.rebuild}/${losses.appendResidual}`
      : 'n/a';
    lines.push(`| ${run.taskId} | #${run.attempt} | ${run.turnsOk}/${run.turns} | ${run.acceptanceOk}/${run.acceptance} `
      + `| ${run.requests ?? 'n/a'} | ${run.input ?? 'n/a'} | ${run.cached ?? 'n/a'} | **${fmt(run.hitPercent)}%** `
      + `| ${nodeText} | ${lossText} | ${run.conclusion ?? 'n/a'} |`);
  }
  lines.push('');
  lines.push('## 损失归因（实测分解）');
  lines.push('');
  lines.push('每个会话的未缓存输入按三类归因：`coldStart`（该会话首个请求）、`rebuild`（单请求未缓存 ≥1024 tokens，');
  lines.push('远高于供应商 128-token 块残差，说明提示词被重建而非追加）、`appendResidual`（追加步的新内容与块残差）。');
  lines.push('');
  lines.push('| 任务 | 次数 | coldStart | rebuild | appendResidual | 可回收重用浪费 | 重建事件（请求序号：跨 run） | 派生上界（回收浪费 / 冷启动也缓存） |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const run of data.results) {
    const losses = run.losses;
    if (!losses) {
      lines.push(`| ${run.taskId} | #${run.attempt} | n/a | n/a | n/a | n/a | n/a | n/a |`);
      continue;
    }
    const events = losses.rebuildEvents
      .map((event) => `#${event.ordinal}(-${Math.max(0, (event.previousInput ?? 0) - (event.input ?? 0))})`)
      .join(', ') || '无';
    lines.push(`| ${run.taskId} | #${run.attempt} | ${losses.coldStart} | ${losses.rebuild} | ${losses.appendResidual} `
      + `| ${losses.reuseWaste.total} | ${events} `
      + `| ${fmt(losses.derivedBounds.reuseWasteRecovered.hitPercent)}% / ${fmt(losses.derivedBounds.coldStartAlsoCached.hitPercent)}% |`);
  }
  lines.push('');
  lines.push('“派生上界”是把已发送过的 token 视为可缓存后的模型值，不是实测值；它说明在同样的请求构成下最多能到多少。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

writeFileSync(jsonPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
writeFileSync(markdownPath, markdown(aggregate), 'utf8');
console.log(`runs=${aggregate.runs}/${aggregate.expectedRuns} met=${aggregate.metRuns} `
  + `functionalFailures=${aggregate.runsWithFunctionalFailure} usageComplete=${aggregate.usageCompleteRuns}`);
for (const run of aggregate.results) {
  console.log(`  ${run.taskId}#${run.attempt} turns=${run.turnsOk}/${run.turns} acceptance=${run.acceptanceOk}/${run.acceptance} `
    + `H_ui=${fmt(run.hitPercent)}% nodes=${run.nodes.map((node) => fmt(node.hitPercent, 1)).join('/')} `
    + `losses=${run.losses ? `${run.losses.coldStart}/${run.losses.rebuild}/${run.losses.appendResidual}` : 'n/a'}`);
  for (const failed of run.failedChecks) console.log(`      failed check: ${failed}`);
}
console.log(`json: ${jsonPath}`);
console.log(`markdown: ${markdownPath}`);
