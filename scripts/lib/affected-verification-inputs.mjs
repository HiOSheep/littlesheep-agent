import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function comparableManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { scripts: _scripts, ...contract } = value;
  return stableValue(contract);
}

function scriptsOf(value) {
  return stableValue(value && typeof value === 'object' && !Array.isArray(value) ? value.scripts ?? {} : {});
}

function hasValidScriptsShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scripts = value.scripts;
  return scripts === undefined || (scripts && typeof scripts === 'object' && !Array.isArray(scripts));
}

function readGitJson(repoRoot, ref) {
  const result = spawnSync('git', ['show', `${ref}:package.json`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function readIndexJson(repoRoot) {
  const result = spawnSync('git', ['show', ':package.json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function readWorkingJson(repoRoot) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function differs(left, right) {
  return JSON.stringify(left) !== JSON.stringify(right);
}

const TEST_INVALIDATING_SCRIPT_KEYS = new Set([
  'check:repo',
  'test',
  'test:changed',
  'test:core-eval',
  'test:fast',
  'test:full',
  'typecheck:changed',
]);

const FULL_TEST_SCRIPT_KEYS = new Set([
  'test',
  'test:core-eval',
  'test:fast',
  'test:full',
]);

export const AFFECTED_SELECTOR_IMPLEMENTATION_FILES = Object.freeze([
  'scripts/run-affected-verification.mjs',
  'scripts/run-verification-gate.mjs',
  'scripts/run-task-verification.mjs',
  'scripts/lib/affected-verification-base.mjs',
  'scripts/lib/affected-verification-inputs.mjs',
  'scripts/measure-verification-baseline.mjs',
  'scripts/workspace-projects.mjs',
]);

export const AFFECTED_SELECTOR_REGRESSION_TESTS = Object.freeze([
  'scripts/run-affected-verification.test.mjs',
  'scripts/run-verification-gate.test.mjs',
  'scripts/run-task-verification.test.mjs',
  'scripts/lib/affected-verification-inputs.test.mjs',
  'scripts/measure-verification-baseline.test.mjs',
  'test/development-workflow.test.ts',
]);

export const GLOBAL_TYPECHECK_FILES = Object.freeze([
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.workspace.json',
]);

// These files are loaded by the development/runtime bootstrap. They are not
// TypeScript project contracts or Electron build inputs, but a change must
// still reach a test gate instead of being treated as a no-op selection.
export const RUNTIME_CONFIG_FILES = Object.freeze([
  'branding.config.json',
  'littlesheep.config.json',
]);

const TEST_RELEVANT_PATTERN = /^(packages|scripts|test)\/.*\.(?:[cm]?[jt]sx?|json)$/;
const PACKAGE_CONFIG_PATTERN = /(?:^|\/)(?:package|tsconfig(?:\.[^/]+)?)\.json$/;

function normalizePlanFile(file) {
  return String(file).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Build the one test-selection plan consumed by both the executor and the
 * baseline measurement report. Keeping the explicit selector suite and the
 * related-input exclusions here prevents the two entry points drifting apart.
 */
export function createAffectedTestPlan(
  files,
  base,
  repoRootForCheck = process.cwd(),
  {
    rootPackageChange = null,
    workspaceManifestFiles = [],
  } = {},
) {
  const normalizedFiles = [...new Set(files.map(normalizePlanFile))];
  const testRelevantFiles = normalizedFiles.filter((file) => (
    TEST_RELEVANT_PATTERN.test(file) && !PACKAGE_CONFIG_PATTERN.test(file)
  ));
  const selectorImplementationFiles = new Set(AFFECTED_SELECTOR_IMPLEMENTATION_FILES);
  const selectorRegressionTests = new Set(AFFECTED_SELECTOR_REGRESSION_TESTS);
  const selectorChanged = normalizedFiles.some((file) => (
    selectorImplementationFiles.has(file) || selectorRegressionTests.has(file)
  ));
  const explicitSelectorTests = selectorChanged
    ? [...AFFECTED_SELECTOR_REGRESSION_TESTS]
    : [];
  const relatedTestRelevantFiles = testRelevantFiles.filter((file) => (
    !selectorImplementationFiles.has(file) && !selectorRegressionTests.has(file)
  ));
  const vitestConfigChanged = normalizedFiles.some(isVitestConfigPath);
  const runtimeConfigChanged = normalizedFiles.some((file) => (
    RUNTIME_CONFIG_FILES.includes(file)
  ));
  const rootTestSetChanged = Boolean(rootPackageChange?.requiresFullTests);
  const fullTests = vitestConfigChanged || rootTestSetChanged;
  const deletedTestInputs = testRelevantFiles.filter((file) => (
    !existsSync(resolve(repoRootForCheck, file))
  ));
  const manifestFiles = workspaceManifestFiles.map(normalizePlanFile).filter(Boolean);
  const fallbackReasons = [];
  if (vitestConfigChanged) fallbackReasons.push('vitest-config-changed');
  if (rootTestSetChanged) fallbackReasons.push('root-test-set-changed');
  if (deletedTestInputs.length > 0) fallbackReasons.push('deleted-test-input');
  if (manifestFiles.length > 0) fallbackReasons.push('workspace-manifest-changed');
  if (runtimeConfigChanged) fallbackReasons.push('runtime-config-changed');
  if (rootPackageChange?.testInvalidating && !rootPackageChange?.requiresFullTests) {
    fallbackReasons.push('verification-script-changed');
  }
  if (relatedTestRelevantFiles.length > 100) fallbackReasons.push('more-than-100-test-relevant-files');

  let mode = 'skip';
  if (fullTests) mode = 'full';
  else if (fallbackReasons.length > 0) mode = 'changed-fallback';
  else if (explicitSelectorTests.length > 0) mode = 'explicit';
  else if (relatedTestRelevantFiles.length > 0) mode = 'related';

  return {
    mode,
    fullTests,
    selectorChanged,
    runtimeConfigChanged,
    testRelevantFiles,
    explicitSelectorTests,
    relatedTestRelevantFiles,
    deletedTestInputs,
    fallbackReasons,
    changedSelector: mode === 'changed-fallback' ? `--changed=${base ?? 'unresolved'}` : null,
  };
}

function isTestInvalidatingScriptKey(key) {
  return TEST_INVALIDATING_SCRIPT_KEYS.has(key) || key.startsWith('verify:');
}

/**
 * Identify root scripts that define or orchestrate verification. The caller
 * uses this signal to bypass mutable package scripts and invoke Vitest safely.
 */
export function classifyVerificationScriptChanges(base, index, working) {
  if (!base || !index || !working) {
    return {
      testInvalidating: true,
      requiresFullTests: true,
      testInvalidatingScriptKeys: [],
      fullTestScriptKeys: [],
    };
  }

  if (![base, index, working].every(hasValidScriptsShape)) {
    return {
      testInvalidating: true,
      requiresFullTests: true,
      testInvalidatingScriptKeys: [],
      fullTestScriptKeys: [],
    };
  }

  const snapshots = [base.scripts ?? {}, index.scripts ?? {}, working.scripts ?? {}];
  const keys = new Set(snapshots.flatMap((scripts) => Object.keys(scripts)));
  const testInvalidatingScriptKeys = [...keys]
    .filter((key) => isTestInvalidatingScriptKey(key))
    .filter((key) => snapshots[0][key] !== snapshots[1][key] || snapshots[1][key] !== snapshots[2][key])
    .sort();
  const fullTestScriptKeys = testInvalidatingScriptKeys
    .filter((key) => FULL_TEST_SCRIPT_KEYS.has(key));

  return {
    testInvalidating: testInvalidatingScriptKeys.length > 0,
    requiresFullTests: fullTestScriptKeys.length > 0,
    testInvalidatingScriptKeys,
    fullTestScriptKeys,
  };
}

/**
 * Root package scripts are verification/build orchestration, not automatically
 * a workspace type contract. Any unavailable or malformed snapshot fails closed.
 */
export function classifyPackageSnapshots(base, index, working) {
  if (![base, index, working].every(hasValidScriptsShape)) {
    return {
      available: false,
      requiresGlobalTypecheck: true,
      scriptsChanged: true,
      buildScriptChanged: true,
      reason: 'package-json-snapshot-unavailable',
    };
  }

  const requiresGlobalTypecheck = differs(comparableManifest(base), comparableManifest(index))
    || differs(comparableManifest(index), comparableManifest(working));
  const scriptsChanged = differs(scriptsOf(base), scriptsOf(index)) || differs(scriptsOf(index), scriptsOf(working));
  const buildKeys = ['build', 'build:app', 'build:electron'];
  const buildScriptChanged = buildKeys.some((key) => (
    (base.scripts ?? {})[key] !== (index.scripts ?? {})[key]
      || (index.scripts ?? {})[key] !== (working.scripts ?? {})[key]
  ));

  return {
    available: true,
    requiresGlobalTypecheck,
    scriptsChanged,
    buildScriptChanged,
    reason: requiresGlobalTypecheck ? 'package-contract-changed' : scriptsChanged ? 'scripts-only' : 'unchanged',
  };
}

export function classifyRootPackageChange(repoRoot, mergeBase) {
  const base = readGitJson(repoRoot, mergeBase);
  const index = readIndexJson(repoRoot);
  const working = readWorkingJson(repoRoot);
  return {
    ...classifyPackageSnapshots(base, index, working),
    ...classifyVerificationScriptChanges(base, index, working),
  };
}

export function isVitestConfigPath(file) {
  return /^vitest\.config\./.test(file);
}

export function isAppBuildSensitivePath(file, affectedProjectNames, rootPackageChange = null) {
  if (file === 'package.json') {
    return Boolean(rootPackageChange?.buildScriptChanged || rootPackageChange?.requiresGlobalTypecheck);
  }
  if (file === 'pnpm-lock.yaml' || file === 'pnpm-workspace.yaml' || file === 'tsconfig.base.json' || file === 'tsconfig.workspace.json') {
    return true;
  }
  if (/^(?:electron|vite)\.config\./.test(file)) return true;
  if (/^packages\/app\/(?:package\.json|electron\.vite\.config\.[^/]+|tsconfig(?:\.[^/]+)?\.json)$/.test(file)) return true;
  if (file.startsWith('packages/app/src/') && !/(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[^.]+$/.test(file)) return true;
  if (/^packages\/app\/resources\/.*\.(?:css|html|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|wasm)$/i.test(file)) return true;
  if (/^packages\/(?:channels\/[^/]+|[^/]+)\/package\.json$/.test(file)) {
    return affectedProjectNames.has('@littlesheep/app');
  }
  return false;
}
