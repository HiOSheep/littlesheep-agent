// Cache acceptance gate.
//
// Turns the taskbook's acceptance rules into one command. Two kinds of evidence are
// judged differently, because they answer different questions:
//
//   * the long task is where the red line is reachable. Its milestones from
//     `--long-task-cutoff` on must be >=95% in at least `--long-task-runs` runs, and
//     every run must pass its artifact checks with complete usage. The milestones
//     before the cutoff are exempt on purpose: a session's first requests carry the
//     cold start, which only session length can amortise, so demanding 95% at turn 1
//     would be demanding something no architecture can deliver.
//   * the frozen six are the functional regression set. Their three-turn shape
//     cannot amortise the cold start, so the gate requires artifact acceptance,
//     complete usage and no unexplained loss — not the ratio.
//
// A run whose provider report the Runtime cannot corroborate fails the gate: it means
// a request differed from what the Runtime recorded, which is a defect until proven
// otherwise. Diagnostic runs (compaction override, process restart) are reported and
// excluded unless `--include-diagnostic` is passed.
//
// Usage: node scripts/check-cache-acceptance.mjs [--json <path> ...] [--dir <path> ...]
//        [--long-task-cutoff <turn>] [--long-task-runs <n>] [--include-diagnostic]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LONG = 'docs/reference/cache-baseline/long-interval-task-L1-2026-09-22.json';
const DEFAULT_FROZEN = 'docs/reference/cache-baseline/real-long-task-baseline-pinned-interval-2026-09-22.json';

function valueOf(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function allOf(flag) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && index + 1 < process.argv.length) values.push(process.argv[index + 1]);
  }
  return values;
}

const cutoff = Number(valueOf('--long-task-cutoff') ?? 16);
const requiredLongRuns = Number(valueOf('--long-task-runs') ?? 2);
const includeDiagnostic = process.argv.includes('--include-diagnostic');

function loadInputs() {
  const paths = [
    ...allOf('--json'),
    ...allOf('--dir').flatMap((dir) => readdirSync(resolve(repoRoot, dir))
      .filter((name) => /^real-long-task-.*\.json$/u.test(name))
      .map((name) => join(dir, name))),
  ];
  if (paths.length === 0) paths.push(DEFAULT_LONG, DEFAULT_FROZEN);
  const runs = [];
  for (const path of paths) {
    const absolute = resolve(repoRoot, path);
    if (!existsSync(absolute)) {
      runs.push({ path, missing: true });
      continue;
    }
    const parsed = JSON.parse(readFileSync(absolute, 'utf8'));
    for (const run of parsed.results ?? []) runs.push({ path, ...run });
  }
  return runs;
}

/** One run's acceptance, as the taskbook states it. */
function judgeRun(run) {
  const problems = [];
  if (run.missing) return { problems: [`报告缺失：${run.path}`], kind: 'missing' };
  const label = `${run.taskId}#${run.attempt}`;
  if (run.acceptanceOk !== run.acceptance) {
    problems.push(`${label} 产物验收 ${run.acceptanceOk}/${run.acceptance}${run.failedChecks?.length ? `（${run.failedChecks.join('；')}）` : ''}`);
  }
  if (run.requestsWithoutUsage > 0 && run.hitPercentWithoutInconsistencies === null) {
    problems.push(`${label} usage 不完整（${run.requestsWithoutUsage} 个请求无 usage）`);
  }
  if ((run.providerInconsistencies ?? 0) > 0) {
    problems.push(`${label} 有 ${run.providerInconsistencies} 次 provider 上报与 Runtime 记录矛盾`);
  }
  const milestones = (run.nodes ?? []).filter((node) => node.turn >= cutoff);
  const below = milestones.filter((node) => node.availability === 'complete'
    && typeof node.hitPercent === 'number' && node.hitPercent < 95);
  return {
    label,
    kind: run.taskId.startsWith('L') ? 'long' : 'frozen',
    problems,
    milestones: milestones.length,
    belowTarget: below.map((node) => `${node.id}@${node.turn} ${node.hitPercent.toFixed(2)}%`),
    hitPercent: run.hitPercent,
  };
}

const runs = loadInputs().filter((run) => includeDiagnostic || run.diagnostic !== true);
const judged = runs.map(judgeRun);
const longRuns = judged.filter((run) => run.kind === 'long');
const frozenRuns = judged.filter((run) => run.kind === 'frozen');

const problems = [];
for (const run of judged) problems.push(...run.problems);
for (const run of longRuns) {
  if (run.belowTarget.length > 0) problems.push(`${run.label} 第 ${cutoff} 回合起的冻结节点低于 95%：${run.belowTarget.join('、')}`);
}
const longWithMilestones = longRuns.filter((run) => run.milestones > 0 && run.belowTarget.length === 0);
if (longWithMilestones.length < requiredLongRuns) {
  problems.push(`长任务达标运行 ${longWithMilestones.length}/${requiredLongRuns}（要求第 ${cutoff} 回合起的所有冻结节点 ≥95%）`);
}

console.log(`缓存验收门：长任务口径=第 ${cutoff} 回合起节点 ≥95% 且至少 ${requiredLongRuns} 次；冻结清单口径=产物验收 + usage 完整 + 无未解释矛盾`);
for (const run of judged) {
  const status = run.problems.length === 0 && run.belowTarget?.length === 0 ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${run.label ?? run.path} H_ui=${run.hitPercent?.toFixed?.(2) ?? '-'}% `
    + `第${cutoff}+节点 ${run.milestones ?? 0} 个${run.belowTarget?.length ? `，低于目标：${run.belowTarget.join('、')}` : ''}`);
}
console.log(`长任务 \`>=95%\` 达标运行：${longWithMilestones.length}/${longRuns.length}（${longWithMilestones.map((run) => run.label).join('、') || '无'}）`);
console.log(`冻结清单运行：${frozenRuns.length} 次（口径为功能回归，不含红线）`);
if (problems.length === 0) {
  console.log('结论：met');
  process.exitCode = 0;
} else {
  console.log(`结论：not met（${problems.length} 项）`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
}
