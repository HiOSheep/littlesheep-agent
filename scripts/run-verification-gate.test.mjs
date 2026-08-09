import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyStageStatus,
  parseArgs,
  runVerificationGate,
  summarizeGateReport,
} from './run-verification-gate.mjs';

const repoRoot = process.cwd();

async function withReportDirectory(callback) {
  const directory = await mkdtemp(join(repoRoot, '.codex_tmp', 'gate-test-'));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function result(status = 0, stdout = '', stderr = '') {
  return { status, signal: null, stdout, stderr, durationMs: 1.5 };
}

function argsOf(spec) {
  return (spec.commands ?? [{ command: spec.command, args: spec.args }]).flatMap((item) => item.args ?? []);
}

function selectorPlan({ typecheck = false, tests = 'skip', build = false } = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    report: 'affected-verification-plan',
    mergeBase: 'fixture-base',
    changedFiles: ['packages/harness/src/default-harness.ts'],
    directPackages: ['@littlesheep/harness'],
    affectedPackages: typecheck ? ['@littlesheep/harness'] : [],
    typecheckConfigPaths: typecheck ? ['packages/harness/tsconfig.json'] : [],
    testPlan: {
      mode: tests,
      fullTests: tests === 'full',
      explicitSelectorTests: [],
      relatedTestRelevantFiles: tests === 'related' ? ['packages/harness/src/default-harness.ts'] : [],
      fallbackReasons: [],
    },
    appBuildSensitiveFiles: build ? ['packages/app/src/main/index.ts'] : [],
    appBuildSensitive: build,
  });
}

describe('verification gate runner', () => {
  it('parses gate options and filters pnpm forwarding separator', () => {
    expect(parseArgs(['--', '--gate=core', '--keep=3'])).toMatchObject({ gate: 'core', keep: 3 });
  });

  it('classifies zero-exit no-op stages as skipped', () => {
    expect(classifyStageStatus(result(0, '[affected] typecheck skipped: no affected package'), 'typecheck')).toBe('skipped');
    expect(classifyStageStatus(result(0, '[affected] tests skipped: no related source or test file'), 'tests')).toBe('skipped');
    expect(classifyStageStatus(result(0, 'done'), 'tests')).toBe('executed');
    expect(classifyStageStatus(result(1), 'build')).toBe('failed');
  });

  it('writes a passed changed report with selector evidence and rotates history', async () => {
    await withReportDirectory(async (reportDirectory) => {
      const execute = async (spec) => {
        if (argsOf(spec).includes('--list')) return result(0, selectorPlan());
        return result(0, '[affected] typecheck skipped: no affected package\n[affected] tests skipped: no related source or test file');
      };
      const report = await runVerificationGate({ gate: 'changed', execute, reportDirectory, keep: 1 });
      expect(report.status).toBe('passed');
      expect(report.failedStage).toBeNull();
      expect(report.selection.testPlan.mode).toBe('skip');
      expect(report.stages.map((stage) => [stage.name, stage.status])).toEqual([
        ['check:repo', 'executed'],
        ['selector', 'executed'],
        ['typecheck', 'skipped'],
        ['tests', 'skipped'],
        ['build', 'skipped'],
        ['recovery', 'skipped'],
      ]);
      expect((await readFile(report.reportPath, 'utf8'))).toContain('"report": "verification-gate"');
      expect(summarizeGateReport(report)).toContain('changed passed');
      const history = (await readdir(reportDirectory)).filter((name) => /^\d+-\d+\.json$/u.test(name));
      expect(history).toHaveLength(1);
    });
  });

  it.each([
    ['selector', 'changed', (spec) => argsOf(spec).includes('--list')],
    ['typecheck', 'changed', (spec) => argsOf(spec).includes('tsc')],
    ['tests', 'full', (spec) => argsOf(spec).includes('test')],
    ['build', 'full', (spec) => argsOf(spec).includes('build:app')],
    ['recovery', 'full', (spec) => argsOf(spec).includes('verify:app-recovery')],
  ])('stops and records a %s failure', async (failedStage, gate, matches) => {
    await withReportDirectory(async (reportDirectory) => {
      const execute = async (spec) => {
        if (matches(spec)) return result(1, '', `${failedStage} fixture failure`);
        if (argsOf(spec).includes('--list')) {
          return result(0, selectorPlan({ typecheck: failedStage === 'typecheck', tests: failedStage === 'tests' ? 'related' : 'skip' }));
        }
        return result(0, 'done');
      };
      const report = await runVerificationGate({ gate, execute, reportDirectory });
      expect(report.status).toBe('failed');
      expect(report.failedStage).toBe(failedStage);
      expect(report.stages.find((stage) => stage.name === failedStage)).toMatchObject({ status: 'failed', exitCode: 1 });
      expect(
        report.stages.some((stage) => stage.reason?.includes(`blocked by failed stage ${failedStage}`))
          || report.stages.find((stage) => stage.name === failedStage)?.name === failedStage,
      ).toBe(true);
    });
  });
});
