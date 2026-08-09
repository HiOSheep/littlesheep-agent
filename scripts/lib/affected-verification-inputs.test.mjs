import { describe, expect, it } from 'vitest';
import {
  classifyPackageSnapshots,
  classifyVerificationScriptChanges,
  createAffectedTestPlan,
  AFFECTED_SELECTOR_REGRESSION_TESTS,
  GLOBAL_TYPECHECK_FILES,
  RUNTIME_CONFIG_FILES,
  isAppBuildSensitivePath,
  isVitestConfigPath,
} from './affected-verification-inputs.mjs';

const base = {
  name: 'littlesheep',
  private: true,
  type: 'module',
  dependencies: { alpha: '1.0.0' },
  scripts: {
    build: 'pnpm run typecheck && pnpm --filter @littlesheep/app run build',
    test: 'vitest run',
  },
};

describe('affected verification root package classification', () => {
  it('keeps global typecheck inputs in one shared list', () => {
    expect(GLOBAL_TYPECHECK_FILES).toEqual([
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
      'tsconfig.workspace.json',
    ]);
    expect(RUNTIME_CONFIG_FILES).toEqual([
      'branding.config.json',
      'littlesheep.config.json',
    ]);
  });

  it('does not silently skip top-level runtime configuration changes', () => {
    for (const file of RUNTIME_CONFIG_FILES) {
      const plan = createAffectedTestPlan([file], 'abc123', process.cwd());
      expect(plan.mode).toBe('changed-fallback');
      expect(plan.runtimeConfigChanged).toBe(true);
      expect(plan.fallbackReasons).toContain('runtime-config-changed');
      expect(plan.changedSelector).toBe('--changed=abc123');
    }
  });
  it('does not make a scripts-only edit invalidate every workspace typecheck', () => {
    const working = structuredClone(base);
    working.scripts.test = 'vitest run --reporter=dot';

    expect(classifyPackageSnapshots(base, base, working)).toEqual({
      available: true,
      requiresGlobalTypecheck: false,
      scriptsChanged: true,
      buildScriptChanged: false,
      reason: 'scripts-only',
    });
  });

  it('keeps dependency and manifest contract changes fail-closed to full typecheck', () => {
    const working = structuredClone(base);
    working.dependencies.alpha = '2.0.0';

    expect(classifyPackageSnapshots(base, base, working)).toMatchObject({
      requiresGlobalTypecheck: true,
      reason: 'package-contract-changed',
    });
  });

  it('marks build script edits as App build-sensitive without global typecheck', () => {
    const working = structuredClone(base);
    working.scripts.build = 'pnpm run typecheck && pnpm run build:app';
    working.scripts['build:app'] = 'pnpm --filter @littlesheep/app run build';

    expect(classifyPackageSnapshots(base, base, working)).toMatchObject({
      requiresGlobalTypecheck: false,
      scriptsChanged: true,
      buildScriptChanged: true,
      reason: 'scripts-only',
    });
  });

  it('fails closed when any package snapshot cannot be parsed', () => {
    expect(classifyPackageSnapshots(base, null, base)).toMatchObject({
      available: false,
      requiresGlobalTypecheck: true,
      reason: 'package-json-snapshot-unavailable',
    });
  });

  it('fails closed when all root package snapshots have an invalid object shape', () => {
    expect(classifyPackageSnapshots([], [], [])).toEqual({
      available: false,
      requiresGlobalTypecheck: true,
      scriptsChanged: true,
      buildScriptChanged: true,
      reason: 'package-json-snapshot-unavailable',
    });
  });

  it('marks verification orchestration scripts as test-invalidating', () => {
    const working = structuredClone(base);
    working.scripts['test:changed'] = 'node scripts/run-affected-verification.mjs --tests-only --list';
    working.scripts['verify:changed'] = 'pnpm run check:repo && pnpm run test:changed';

    expect(classifyVerificationScriptChanges(base, base, working)).toEqual({
      testInvalidating: true,
      requiresFullTests: false,
      testInvalidatingScriptKeys: ['test:changed', 'verify:changed'],
      fullTestScriptKeys: [],
    });
  });

  it('uses direct Vitest for changes that define the full test set', () => {
    const working = structuredClone(base);
    working.scripts.test = 'vitest run --reporter=verbose';
    working.scripts['test:fast'] = 'pnpm run test:core-eval --reporter=dot';
    working.scripts['test:full'] = 'vitest run --passWithNoTests';

    expect(classifyVerificationScriptChanges(base, base, working)).toEqual({
      testInvalidating: true,
      requiresFullTests: true,
      testInvalidatingScriptKeys: ['test', 'test:fast', 'test:full'],
      fullTestScriptKeys: ['test', 'test:fast', 'test:full'],
    });
  });

  it('does not treat unrelated root scripts as test-invalidating', () => {
    const working = structuredClone(base);
    working.scripts.start = 'node packages/cli/dist/bin.js --verbose';

    expect(classifyVerificationScriptChanges(base, base, working)).toEqual({
      testInvalidating: false,
      requiresFullTests: false,
      testInvalidatingScriptKeys: [],
      fullTestScriptKeys: [],
    });
  });

  it('fails closed when verification script snapshots are unavailable', () => {
    expect(classifyVerificationScriptChanges(base, null, base)).toEqual({
      testInvalidating: true,
      requiresFullTests: true,
      testInvalidatingScriptKeys: [],
      fullTestScriptKeys: [],
    });
  });

  it('fails closed when a package snapshot has an invalid scripts shape', () => {
    const malformed = structuredClone(base);
    malformed.scripts = ['vitest', 'run'];

    expect(classifyVerificationScriptChanges(base, base, malformed)).toEqual({
      testInvalidating: true,
      requiresFullTests: true,
      testInvalidatingScriptKeys: [],
      fullTestScriptKeys: [],
    });
  });

  it('does not treat App README or tests as build inputs', () => {
    const affected = new Set(['@littlesheep/app']);
    expect(isAppBuildSensitivePath('packages/app/README.md', affected)).toBe(false);
    expect(isAppBuildSensitivePath('docs/architecture.png', affected)).toBe(false);
    expect(isAppBuildSensitivePath('packages/app/src/main/index.test.ts', affected)).toBe(false);
    expect(isAppBuildSensitivePath('packages/app/src/main/index.ts', affected)).toBe(true);
    expect(isAppBuildSensitivePath('packages/app/electron.vite.config.ts', affected)).toBe(true);
    expect(isAppBuildSensitivePath('packages/app/resources/littlesheep-icon.png', affected)).toBe(true);
  });

  it('recognizes all Vitest config extensions as full-test inputs', () => {
    for (const file of ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs']) {
      expect(isVitestConfigPath(file)).toBe(true);
    }
    expect(isVitestConfigPath('vite.config.ts')).toBe(false);
  });

  it('shares selector explicit tests and related-input exclusions', () => {
    const plan = createAffectedTestPlan([
      'scripts/run-affected-verification.mjs',
      'scripts/run-affected-verification.test.mjs',
      'packages/harness/src/default-harness.ts',
      'packages/harness/package.json',
    ], 'abc123', process.cwd(), {
      workspaceManifestFiles: ['packages/harness/package.json'],
    });

    expect(plan.explicitSelectorTests).toEqual(AFFECTED_SELECTOR_REGRESSION_TESTS);
    expect(plan.relatedTestRelevantFiles).toEqual(['packages/harness/src/default-harness.ts']);
    expect(plan.mode).toBe('changed-fallback');
    expect(plan.fallbackReasons).toContain('workspace-manifest-changed');
    expect(plan.changedSelector).toBe('--changed=abc123');
  });

  it('uses the shared threshold for broad related inputs', () => {
    const files = Array.from({ length: 101 }, (_, index) => `packages/harness/src/file-${index}.ts`);
    const plan = createAffectedTestPlan(files, 'abc123', process.cwd());

    expect(plan.mode).toBe('changed-fallback');
    expect(plan.fallbackReasons).toContain('more-than-100-test-relevant-files');
  });
});
