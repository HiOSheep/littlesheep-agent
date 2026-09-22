import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeAcceptance, CACHE_TARGET_PERCENT } from './lib/cache-acceptance.mjs';

// Cache acceptance gate.
//
// Usage: node scripts/check-cache-acceptance.mjs [--json <path> ...] [--dir <path> ...]
//        [--long-task-cutoff <turn>] [--long-task-runs <n>] [--include-diagnostic]
//
// The rules themselves live in scripts/lib/cache-acceptance.mjs and are unit-tested
// there; this file only loads reports and prints the verdict.
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

const runs = loadInputs().filter((run) => includeDiagnostic || run.diagnostic !== true);
const verdict = judgeAcceptance(runs, { cutoff, requiredLongRuns });

console.log(`缓存验收门：长任务口径=第 ${cutoff} 回合起节点 ≥${CACHE_TARGET_PERCENT}% 且至少 ${requiredLongRuns} 次；`
  + '冻结清单口径=产物验收 + usage 完整 + 无未解释矛盾');
for (const run of verdict.judged) {
  const status = run.problems.length === 0 && run.belowTarget.length === 0 ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${run.label ?? run.kind} H_ui=${run.hitPercent?.toFixed?.(2) ?? '-'}% `
    + `第${cutoff}+节点 ${run.milestones} 个${run.belowTarget.length ? `，低于目标：${run.belowTarget.join('、')}` : ''}`);
}
console.log(`长任务 \`>=${CACHE_TARGET_PERCENT}%\` 达标运行：${verdict.longWithMilestones.length}/${verdict.longRuns.length}`
  + `（${verdict.longWithMilestones.map((run) => run.label).join('、') || '无'}）`);
console.log(`冻结清单运行：${verdict.frozenRuns.length} 次（口径为功能回归，不含红线）`);
if (verdict.met) {
  console.log('结论：met');
  process.exitCode = 0;
} else {
  console.log(`结论：not met（${verdict.problems.length} 项）`);
  for (const problem of verdict.problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
}
