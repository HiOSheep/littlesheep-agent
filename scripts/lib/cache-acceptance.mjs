// The acceptance rules, separated from the CLI so they can be tested.
//
// Two kinds of evidence answer different questions:
//   * the long task is where the red line is reachable. Its milestones from `cutoff`
//     on must be >=95% in at least `requiredLongRuns` runs. Earlier milestones are
//     exempt on purpose — a session's first requests carry the cold start, which only
//     session length amortises — but they are still reported node by node.
//   * the frozen six are the functional regression set: artifact acceptance, complete
//     usage and no unexplained provider contradiction. Their three-turn shape cannot
//     amortise the cold start, so the ratio is not the gate.
// A request whose provider report contradicts the Runtime's own record fails either
// kind: that means a request differed from what the Runtime sent.

export const CACHE_TARGET_PERCENT = 95;
export const DEFAULT_LONG_TASK_CUTOFF = 16;
export const DEFAULT_REQUIRED_LONG_RUNS = 2;

/** Judge one run's report. */
export function judgeRun(run, cutoff = DEFAULT_LONG_TASK_CUTOFF) {
  if (run.missing) return { kind: 'missing', problems: [`报告缺失：${run.path}`] };
  const label = `${run.taskId}#${run.attempt}`;
  const problems = [];
  if (run.acceptanceOk !== run.acceptance) {
    problems.push(`${label} 产物验收 ${run.acceptanceOk}/${run.acceptance}`
      + `${run.failedChecks?.length ? `（${run.failedChecks.join('；')}）` : ''}`);
  }
  if (run.requestsWithoutUsage > 0 && run.hitPercentWithoutInconsistencies === null) {
    problems.push(`${label} usage 不完整（${run.requestsWithoutUsage} 个请求无 usage）`);
  }
  if ((run.providerInconsistencies ?? 0) > 0) {
    problems.push(`${label} 有 ${run.providerInconsistencies} 次 provider 上报与 Runtime 记录矛盾`);
  }
  const milestones = (run.nodes ?? []).filter((node) => node.turn >= cutoff);
  const belowTarget = milestones
    .filter((node) => node.availability === 'complete'
      && typeof node.hitPercent === 'number'
      && node.hitPercent < CACHE_TARGET_PERCENT)
    .map((node) => `${node.id}@${node.turn} ${node.hitPercent.toFixed(2)}%`);
  // A milestone whose turn ran but whose requests are missing usage has no verdict at
  // all: the measured sum alone could look like a pass the ledger cannot support.
  // A milestone whose turn never ran is different — its value is the session's state
  // up to that point, measured from real requests — so it is reported, not failed.
  const unmeasured = milestones
    .filter((node) => node.availability !== 'complete' && node.missingTurnRequests !== true)
    .map((node) => `${node.id}@${node.turn}`);
  if (unmeasured.length > 0) {
    problems.push(`${label} 第 ${cutoff} 回合起的冻结节点 usage 不完整：${unmeasured.join('、')}`);
  }
  return {
    label,
    kind: run.taskId?.startsWith('L') ? 'long' : 'frozen',
    problems,
    milestones: milestones.length,
    belowTarget,
    unmeasured,
    hitPercent: run.hitPercent,
  };
}

/**
 * Judge a set of reports. The result is what the CLI prints and what the tests
 * assert: `met` is true only when nothing is wrong.
 */
export function judgeAcceptance(runs, options = {}) {
  const cutoff = options.cutoff ?? DEFAULT_LONG_TASK_CUTOFF;
  const requiredLongRuns = options.requiredLongRuns ?? DEFAULT_REQUIRED_LONG_RUNS;
  const judged = runs.map((run) => judgeRun(run, cutoff));
  const longRuns = judged.filter((run) => run.kind === 'long');
  const frozenRuns = judged.filter((run) => run.kind === 'frozen');
  const problems = judged.flatMap((run) => run.problems);
  for (const run of longRuns) {
    if (run.belowTarget.length > 0) {
      problems.push(`${run.label} 第 ${cutoff} 回合起的冻结节点低于 ${CACHE_TARGET_PERCENT}%：${run.belowTarget.join('、')}`);
    }
  }
  const longWithMilestones = longRuns.filter((run) => (
    run.milestones > 0 && run.belowTarget.length === 0 && run.unmeasured.length === 0
  ));
  if (longWithMilestones.length < requiredLongRuns) {
    problems.push(`长任务达标运行 ${longWithMilestones.length}/${requiredLongRuns}`
      + `（要求第 ${cutoff} 回合起的所有冻结节点 ≥${CACHE_TARGET_PERCENT}%）`);
  }
  return { cutoff, requiredLongRuns, judged, longRuns, frozenRuns, longWithMilestones, problems, met: problems.length === 0 };
}
