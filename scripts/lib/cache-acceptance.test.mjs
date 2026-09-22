import { describe, expect, it } from 'vitest';
import { judgeAcceptance, judgeRun, CACHE_TARGET_PERCENT } from './cache-acceptance.mjs';

function node(id, turn, hitPercent, availability = 'complete') {
  return { id, turn, hitPercent, availability };
}

function run(overrides = {}) {
  return {
    taskId: 'L1',
    attempt: 1,
    acceptanceOk: 6,
    acceptance: 6,
    requestsWithoutUsage: 0,
    providerInconsistencies: 0,
    hitPercent: 99,
    nodes: [node('final', 28, 98.9)],
    ...overrides,
  };
}

describe('cache acceptance rules', () => {
  it('accepts a long run whose milestones from the cutoff are above target', () => {
    const verdict = judgeAcceptance([run(), run({ attempt: 2 })], { cutoff: 16, requiredLongRuns: 2 });
    expect(verdict.met).toBe(true);
    expect(verdict.problems).toEqual([]);
    expect(verdict.longRuns).toHaveLength(2);
    expect(verdict.longWithMilestones).toHaveLength(2);
  });

  it('exempts milestones before the cutoff but still reports them', () => {
    const withColdStart = run({ nodes: [node('survey', 1, 65), node('final', 28, 98)] });
    const judged = judgeRun(withColdStart, 16);
    expect(judged.belowTarget).toEqual([]);
    expect(judged.milestones).toBe(1); // only the turn-28 node is judged
    // Lowering the cutoff to 1 makes the cold start a failure, which is exactly why
    // the taskbook exempts the opening phase.
    expect(judgeRun(withColdStart, 1).belowTarget).toEqual(['survey@1 65.00%']);
  });

  it('fails a run whose later milestone is below target, naming the node', () => {
    const verdict = judgeAcceptance([
      run({ nodes: [node('docs-aligned', 25, 93.4), node('final', 28, 98.9)] }),
      run({ attempt: 2 }),
    ], { cutoff: 16, requiredLongRuns: 2 });
    expect(verdict.met).toBe(false);
    expect(verdict.problems.join('\n')).toContain(`docs-aligned@25 93.40%`);
    expect(verdict.longWithMilestones).toHaveLength(1);
  });

  it('fails when fewer long runs pass than required', () => {
    const verdict = judgeAcceptance([run()], { cutoff: 16, requiredLongRuns: 2 });
    expect(verdict.met).toBe(false);
    expect(verdict.problems.join('\n')).toContain('长任务达标运行 1/2');
  });

  it('fails an incomplete milestone and exempts a turn that never ran', () => {
    // Usage missing on a turn that ran: no verdict, so the run cannot pass.
    const unmeasured = judgeAcceptance([run({ nodes: [node('final', 28, 98.9, 'incomplete')] }), run({ attempt: 2 })],
      { cutoff: 16, requiredLongRuns: 2 });
    expect(unmeasured.longWithMilestones).toHaveLength(1);
    expect(unmeasured.met).toBe(false);
    expect(unmeasured.problems.join('\n')).toContain('usage 不完整：final@28');

    // A turn that never ran still reports the session's measured state, so it is not
    // treated as a measurement failure.
    const neverRan = judgeAcceptance([
      run({ nodes: [{ ...node('final', 28, 98.9, 'incomplete'), missingTurnRequests: true }] }),
      run({ attempt: 2 }),
    ], { cutoff: 16, requiredLongRuns: 2 });
    expect(neverRan.met).toBe(true);
  });

  it('fails artifact acceptance, missing usage and a provider contradiction', () => {
    const verdict = judgeAcceptance([
      run({ acceptanceOk: 5, failedChecks: ['CSV 导出子命令可正常结束'] }),
      run({ attempt: 2, requestsWithoutUsage: 3, hitPercentWithoutInconsistencies: null, providerInconsistencies: 1 }),
    ], { cutoff: 16, requiredLongRuns: 2 });
    expect(verdict.met).toBe(false);
    const text = verdict.problems.join('\n');
    expect(text).toContain('产物验收 5/6');
    expect(text).toContain('usage 不完整');
    expect(text).toContain('provider 上报与 Runtime 记录矛盾');
  });

  it('judges the frozen six by regression, not by the red line', () => {
    const frozen = run({ taskId: 'A1', hitPercent: 88.1, nodes: [node('diagnosis', 1, 47), node('boundary', 3, 88.1)] });
    const verdict = judgeAcceptance([frozen, run(), run({ attempt: 2 })], { cutoff: 16, requiredLongRuns: 2 });
    expect(verdict.frozenRuns).toHaveLength(1);
    expect(verdict.met).toBe(true);
    expect(CACHE_TARGET_PERCENT).toBe(95);
  });

  it('reports a missing report instead of silently ignoring it', () => {
    const verdict = judgeAcceptance([{ path: 'docs/missing.json', missing: true }], { requiredLongRuns: 0 });
    expect(verdict.met).toBe(false);
    expect(verdict.problems.join('\n')).toContain('报告缺失');
  });
});
