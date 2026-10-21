// V2 metrics: per-dimension rates with explicit denominators.
//
// - Goal / Contract rates use passed + failed; not_applicable and unverified are
//   excluded and counted separately.
// - Mechanism rate uses passed + failed among exercised mechanisms;
//   not_exercised, unverified and blocked are excluded and counted separately.
// - Controlled and real-model samples are never mixed; population claims are
//   explicitly refused.
export function computeMetrics(records) {
  const tiers = new Set(records.map((record) => record.evidenceTier));
  if (tiers.size !== 1) {
    const error = new Error(`MIXED_EVIDENCE_TIER: cannot compute one rate over ${[...tiers].join(', ')}`);
    error.code = 'MIXED_EVIDENCE_TIER';
    throw error;
  }
  const tier = [...tiers][0];
  const metric = (statuses, denominatorId) => {
    const passed = statuses.filter((status) => status === 'passed').length;
    const failed = statuses.filter((status) => status === 'failed').length;
    const excluded = {};
    for (const status of statuses) {
      if (status !== 'passed' && status !== 'failed') excluded[status] = (excluded[status] ?? 0) + 1;
    }
    return {
      denominatorId,
      n: passed + failed,
      passed,
      failed,
      excluded,
      populationClaim: false,
      evidenceTier: tier,
    };
  };
  const goalStatuses = records.map((record) => record.dimensions.goal.status);
  const contractStatuses = records.map((record) => record.dimensions.contract.status);
  const mechanismStatuses = records.map((record) => record.dimensions.mechanism.status);
  const perTask = {};
  for (const record of records) {
    perTask[record.taskId] ??= { goal: [], contract: [], mechanism: [] };
    perTask[record.taskId].goal.push(record.dimensions.goal.status);
    perTask[record.taskId].contract.push(record.dimensions.contract.status);
    perTask[record.taskId].mechanism.push(record.dimensions.mechanism.status);
  }
  const perTaskMetrics = {};
  for (const [taskId, statuses] of Object.entries(perTask)) {
    perTaskMetrics[taskId] = {
      goal: metric(statuses.goal, `${tier}:goal:${taskId}`),
      contract: metric(statuses.contract, `${tier}:contract:${taskId}`),
      mechanism: metric(statuses.mechanism, `${tier}:mechanism:${taskId}`),
    };
  }
  return {
    goal: metric(goalStatuses, `${tier}:goal`),
    contract: metric(contractStatuses, `${tier}:contract`),
    mechanism: metric(mechanismStatuses, `${tier}:mechanism`),
    perTask: perTaskMetrics,
  };
}

/** Human-readable rate line that never hides the sample size. */
export function rateSummary(metric) {
  const rate = metric.n === 0 ? null : metric.passed / metric.n;
  const excluded = Object.entries(metric.excluded ?? {}).map(([status, count]) => `${status}=${count}`).join(', ');
  return `${metric.denominatorId}: ${metric.passed}/${metric.n}`
    + (rate === null ? ' (no judged sample)' : ` (${(rate * 100).toFixed(1)}%)`)
    + (excluded ? ` [${excluded}]` : '');
}
