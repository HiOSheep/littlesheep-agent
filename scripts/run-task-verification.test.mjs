import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTaskPlan, parseArgs, runTaskVerification } from './run-task-verification.mjs';

const repoRoot = process.cwd();

async function withReportDirectory(callback) {
  const directory = await mkdtemp(join(repoRoot, '.codex_tmp', 'task-test-'));
  try { return await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function result(status = 0) {
  return { status, signal: null, error: null, stdout: 'fixture stdout', stderr: '', durationMs: 1.25, command: 'fixture' };
}

describe('task verification runner', () => {
  it('requires an explicit task boundary and filters pnpm forwarding', () => {
    expect(parseArgs(['--', '--files=packages/harness/src/continuation-intent.ts'])).toMatchObject({
      files: ['packages/harness/src/continuation-intent.ts'],
      typecheck: true,
      tests: true,
    });
    expect(() => parseArgs([])).toThrow(/Provide --files/u);
  });

  it('plans a single source file without using Git history', async () => {
    const plan = await createTaskPlan(parseArgs(['--files=packages/harness/src/continuation-intent.ts']));
    expect(plan.report).toBe('task-verification-plan');
    expect(plan.task.files).toEqual(['packages/harness/src/continuation-intent.ts']);
    expect(plan.directPackages).toEqual(['@littlesheep/harness']);
    expect(plan.typecheckConfigPaths).toEqual(['packages/harness/tsconfig.json']);
    expect(plan.testPlan.mode).toBe('explicit');
    expect(plan.testPlan.directTests).toEqual(['packages/harness/src/continuation-intent.test.ts']);
    expect(plan.task.manifest).toBeNull();
  });

  it('plans package typecheck and package tests independently of dirty files', async () => {
    const plan = await createTaskPlan(parseArgs(['--package=@littlesheep/memory-tree', '--typecheck-only']));
    expect(plan.directPackages).toEqual(['@littlesheep/memory-tree']);
    expect(plan.typecheckConfigPaths).toEqual(['packages/memory-tree/tsconfig.json']);
    expect(plan.testPlan.mode).toBe('skip');
  });

  it('does not expand a package task into its heavy integration suite by default', async () => {
    const plan = await createTaskPlan(parseArgs(['--package=@littlesheep/runner']));
    expect(plan.testPlan.mode).toBe('skip');
    expect(plan.testPlan.reason).toBe('tests disabled');
    const broadPlan = await createTaskPlan(parseArgs(['--package=@littlesheep/runner', '--package-tests', '--no-typecheck']));
    expect(broadPlan.testPlan.mode).toBe('package');
    expect(broadPlan.testPlan.packageTests.length).toBeGreaterThan(1);
  });

  it('executes a JSON manifest boundary with explicit tests and web typecheck', async () => {
    await withReportDirectory(async (reportDirectory) => {
      const manifestPath = join(reportDirectory, 'task.json');
      await writeFile(manifestPath, JSON.stringify({
        files: ['packages/app/src/renderer/composer/input-size.ts'],
        tests: ['packages/app/src/renderer/composer/input-size.test.ts'],
        typecheck: true,
        appWebTypecheck: true,
      }));
      const plan = await createTaskPlan(parseArgs([`--manifest=${manifestPath}`]));
      expect(plan.task.manifest).toMatch(/task\.json$/u);
      expect(plan.testPlan.mode).toBe('explicit');
      expect(plan.appWebTypecheck).toBe(true);
      const report = await runTaskVerification({
        options: parseArgs([`--manifest=${manifestPath}`]),
        execute: async () => result(0),
        reportDirectory,
      });
      expect(report.status).toBe('passed');
      expect(report.plan.task.manifest).toMatch(/task\.json$/u);
    });
  });

  it('routes renderer source changes to the dedicated App web typecheck', async () => {
    const plan = await createTaskPlan(parseArgs(['--files=packages/app/src/renderer/composer/input-size.ts']));
    expect(plan.appWebTypecheck).toBe(true);
    expect(plan.appWebTypecheckPath).toBe('packages/app/tsconfig.web.json');
    expect(plan.typecheckConfigPaths).toEqual([]);
    expect(plan.testPlan.mode).toBe('explicit');
    expect(plan.testPlan.directTests).toEqual(['packages/app/src/renderer/composer/input-size.test.ts']);
  });

  it('keeps App shared typecheck split between main and web configs', async () => {
    const plan = await createTaskPlan(parseArgs(['--files=packages/app/src/shared/history-activity.ts']));
    expect(plan.appWebTypecheck).toBe(true);
    expect(plan.typecheckConfigPaths).toEqual(['packages/app/tsconfig.json']);
  });

  it('records a failed task stage and rotates local reports', async () => {
    await withReportDirectory(async (reportDirectory) => {
      const execute = async () => result(1);
      const report = await runTaskVerification({
        options: parseArgs(['--files=packages/harness/src/continuation-intent.ts']),
        execute,
        reportDirectory,
        keep: 1,
      });
      expect(report.status).toBe('failed');
      expect(report.failedStage).toBe('tests');
      expect(report.stages.find((stage) => stage.name === 'typecheck').status).toBe('planned');
      expect((await readdir(reportDirectory)).filter((name) => /^\d+-\d+\.json$/u.test(name))).toHaveLength(1);
    });
  });
});
