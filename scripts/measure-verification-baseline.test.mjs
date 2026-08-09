import { describe, expect, it } from 'vitest';
import {
  buildSelection,
  classifyCommandStatus,
  createReport,
  parseArgs,
  repoRelativePath,
  renderMarkdown,
  selectTests,
  spawnInvocation,
} from './measure-verification-baseline.mjs';

describe('verification baseline measurement', () => {
  it('distinguishes skipped no-op gates from executed and failed commands', () => {
    expect(classifyCommandStatus('typecheck', { status: 0, signal: null }, 'typecheck skipped: no affected package')).toBe('skipped');
    expect(classifyCommandStatus('tests', { status: 0, signal: null }, 'tests skipped: no related source or test file')).toBe('skipped');
    expect(classifyCommandStatus('typecheck', { status: 0, signal: null }, 'tsc completed')).toBe('executed');
    expect(classifyCommandStatus('typecheck', { status: 1, signal: null }, '')).toBe('failed');
    expect(classifyCommandStatus('typecheck', { status: 0, signal: 'SIGTERM' }, '')).toBe('failed');
  });
  it('parses a dry-run single-file sample', () => {
    expect(parseArgs([
      '--sample=single-file',
      '--files=packages/harness/src/default-harness.ts',
      '--repeat=2',
      '--format=markdown',
    ])).toMatchObject({
      sample: 'single-file',
      files: ['packages/harness/src/default-harness.ts'],
      repeat: 2,
      format: 'markdown',
      run: null,
    });
  });

  it('selects related tests and transitive dependents for a synthetic package sample', async () => {
    const report = await buildSelection(parseArgs([
      '--sample=single-package',
      '--package=@littlesheep/harness',
    ]));

    expect(report.sample).toBe('single-package');
    expect(report.directPackages).toEqual(['@littlesheep/harness']);
    expect(report.affectedPackages).toContain('@littlesheep/runner');
    expect(report.testSelection.mode).toBe('related');
    expect(report.fingerprints.sourceConfig.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.selectionDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.fingerprintDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.totalDurationMs).toBeGreaterThanOrEqual(
      report.selectionDurationMs + report.fingerprintDurationMs,
    );
    expect(report.timing).toMatchObject({
      planningDurationMs: report.selectionDurationMs,
      fingerprintDurationMs: report.fingerprintDurationMs,
      totalDurationMs: report.totalDurationMs,
    });
  });

  it('marks build-sensitive app files separately from test inputs', async () => {
    const report = await buildSelection(parseArgs([
      '--sample=single-file',
      '--files=packages/app/src/renderer/index.css',
    ]));
    expect(report.appBuildSensitive).toBe(true);
    expect(report.testSelection.mode).toBe('skip');
  });

  it('fails closed for a synthetic package manifest without a baseline', async () => {
    const report = await buildSelection(parseArgs([
      '--sample=single-file',
      '--files=package.json',
    ]));
    expect(report.rootPackageChange).toMatchObject({
      available: false,
      requiresGlobalTypecheck: true,
    });
    expect(report.affectedPackageCount).toBe(27);
    expect(report.appBuildSensitive).toBe(true);
    expect(report.testSelection.mode).toBe('full');
  });

  it('uses changed fallback when a verification script changes without redefining the full test set', () => {
    const selection = selectTests(
      ['package.json'],
      'abc123',
      process.cwd(),
      {
        rootPackageChange: { testInvalidating: true, requiresFullTests: false },
      },
    );

    expect(selection).toMatchObject({
      mode: 'changed-fallback',
      inputFiles: [],
      fallbackReasons: ['verification-script-changed'],
      changedSelector: '--changed=abc123',
    });
  });

  it('uses full tests when root scripts redefine the full test set', () => {
    const selection = selectTests(
      ['package.json'],
      'abc123',
      process.cwd(),
      {
        rootPackageChange: { testInvalidating: true, requiresFullTests: true },
      },
    );

    expect(selection).toMatchObject({
      mode: 'full',
      fallbackReasons: ['root-test-set-changed'],
      changedSelector: null,
    });
  });

  it('uses changed fallback for workspace manifest changes even without source inputs', () => {
    const selection = selectTests(
      ['packages/harness/package.json'],
      'abc123',
      process.cwd(),
      { workspaceManifestFiles: ['packages/harness/package.json'] },
    );

    expect(selection).toMatchObject({
      mode: 'changed-fallback',
      inputFiles: [],
      fallbackReasons: ['workspace-manifest-changed'],
      changedSelector: '--changed=abc123',
    });
  });

  it('reports the same explicit selector suite and related inputs as the executor plan', () => {
    const selection = selectTests([
      'scripts/run-affected-verification.mjs',
      'packages/harness/src/default-harness.ts',
    ], 'abc123', process.cwd());

    expect(selection.mode).toBe('explicit');
    expect(selection.explicitSelectorTests).toContain('scripts/run-affected-verification.test.mjs');
    expect(selection.relatedTestRelevantFiles).toEqual(['packages/harness/src/default-harness.ts']);
    expect(selection.fallbackReasons).toEqual([]);
  });

  it('runs pnpm-backed measurements through the Windows command shim', async () => {
    const report = await createReport(parseArgs([
      '--sample=dirty',
      '--run=typecheck',
    ]));

    const repetition = report.repetitions[0];
    expect(repetition.command.signal).toBeNull();
    expect(repetition.command.error).toBeNull();
    expect(repetition.command.exitCode).toBe(0);
    expect(['executed', 'skipped']).toContain(repetition.command.status);
    expect(repetition.command.actualArgv.at(-1)).toBe('typecheck:changed');
    expect(repetition.selectionDurationMs).toBe(repetition.selection.selectionDurationMs);
    expect(repetition.fingerprintDurationMs).toBe(repetition.selection.fingerprintDurationMs);
    expect(repetition.totalDurationMs).toBeGreaterThanOrEqual(repetition.command.durationMs);
    expect(repetition.buildArtifactEvidence.preRun.sha256).toBe(
      repetition.selection.fingerprints.buildArtifact.sha256,
    );
    expect(repetition.buildArtifactEvidence.postRun).toMatchObject({
      files: expect.any(Number),
      status: expect.stringMatching(/^(?:missing|present)$/u),
    });
    expect(repetition.buildArtifactEvidence.changedByCommand).toBe(false);
  });

  it('rejects executable repeats because commands may change the fixture', () => {
    expect(() => parseArgs([
      '--sample=dirty',
      '--run=selector',
      '--repeat=2',
    ])).toThrow(/cannot be combined with --repeat>1/u);
  });

  it('selects an existing non-test source file for packages without src/index.ts', async () => {
    const report = await buildSelection(parseArgs([
      '--sample=single-package',
      '--package=@littlesheep/app',
    ]));
    const sample = report.changedFiles[0];
    expect(sample).toMatch(/^packages\/app\/src\/.+\.(?:[cm]?[jt]sx?|json)$/u);
    expect(sample).not.toMatch(/\.(?:test|spec)\./u);
    expect(report.testSelection.deletedInputFiles).toEqual([]);
  });

  it('rejects paths on another Windows drive', () => {
    if (process.platform !== 'win32') return;
    expect(() => repoRelativePath('C:/outside/littlesheep-baseline.json', 'Output path')).toThrow(
      /must stay inside the repository/u,
    );
  });

  it('uses an explicit ComSpec argv for Windows command shims', () => {
    if (process.platform !== 'win32') return;
    expect(spawnInvocation('pnpm.cmd', ['run', 'typecheck:changed'])).toMatchObject({
      command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', 'run', 'typecheck:changed'],
    });
  });

  it('renders the complete selector and command evidence in Markdown', () => {
    const output = renderMarkdown({
      generatedAt: '2026-08-09T00:00:00.000Z',
      options: { sample: 'single-file', base: 'origin/main' },
      repetitions: [{
        iteration: 1,
        selectionDurationMs: 1.25,
        fingerprintDurationMs: 2.5,
        selectionTotalDurationMs: 3.75,
        commandDurationMs: 4.5,
        totalDurationMs: 8.25,
        selection: {
          changedFileCount: 1,
          directPackageCount: 1,
          affectedPackageCount: 2,
          categoryCounts: { 'package-source': 1 },
          appBuildSensitive: false,
          testSelection: {
            mode: 'explicit',
            fullTests: false,
            explicitSelectorTests: ['scripts/run-affected-verification.test.mjs'],
            relatedTestRelevantFiles: ['packages/harness/src/default-harness.ts'],
            deletedTestInputs: ['packages/old/src/removed.test.ts'],
            fallbackReasons: ['deleted-test-input'],
          },
        },
        command: {
          status: 'executed',
          actualArgv: ['node', 'scripts/run-affected-verification.mjs', '--list'],
          durationMs: 4.5,
        },
        buildArtifactEvidence: {
          preRun: { sha256: 'before' },
          postRun: { sha256: 'after' },
          changedByCommand: true,
        },
      }],
    });

    expect(output).toContain('Planning ms');
    expect(output).toContain('Fingerprint ms');
    expect(output).toContain('Selection total ms');
    expect(output).toContain('Full tests: false');
    expect(output).toContain('Explicit selector tests: ["scripts/run-affected-verification.test.mjs"]');
    expect(output).toContain('Related test-relevant files: ["packages/harness/src/default-harness.ts"]');
    expect(output).toContain('Deleted test inputs: ["packages/old/src/removed.test.ts"]');
    expect(output).toContain('Fallback reasons: ["deleted-test-input"]');
    expect(output).toContain('Actual argv: ["node","scripts/run-affected-verification.mjs","--list"]');
    expect(output).toContain('Command status: executed');
  });

});
