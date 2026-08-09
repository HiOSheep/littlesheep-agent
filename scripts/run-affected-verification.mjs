import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverWorkspaceProjects,
  includeDependents,
  normalizeRepoPath,
  projectConfigPaths,
  projectsForFiles,
  isWorkspacePackageManifestPath,
  validateWorkspaceManifestGraphs,
} from './workspace-projects.mjs';
import { readGitLines, resolveGitMergeBase } from './lib/affected-verification-base.mjs';
import {
  createAffectedTestPlan,
  classifyRootPackageChange,
  GLOBAL_TYPECHECK_FILES,
  isAppBuildSensitivePath,
} from './lib/affected-verification-inputs.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2).filter((value) => value !== '--'));
const baseArg = process.argv.find((value) => value.startsWith('--base='));
const base = baseArg?.slice('--base='.length) || process.env.LITTLESHEEP_BASE_REF || 'origin/main';
const runTypecheck = !args.has('--tests-only');
const runTests = !args.has('--typecheck-only');
const runBuildSensitive = !args.has('--tests-only') && !args.has('--typecheck-only');
const listOnly = args.has('--list');
const jsonOnly = args.has('--json');
const pnpmCli = process.env.npm_execpath;

function run(command, commandArgs, options = {}) {
  const startedAt = performance.now();
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) process.exit(result.status ?? 1);
  if (!options.capture) {
    const label = options.label ?? command;
    console.log(`[affected] ${label} completed in ${((performance.now() - startedAt) / 1000).toFixed(2)}s`);
  }
  return result.stdout?.trim() ?? '';
}

function runPnpm(commandArgs) {
  if (!pnpmCli) throw new Error('Run affected verification through a pnpm script so npm_execpath is available.');
  return run(process.execPath, [pnpmCli, ...commandArgs], { label: `pnpm ${commandArgs[0]}` });
}

let mergeBase;
try {
  mergeBase = resolveGitMergeBase(base, repoRoot);
} catch (error) {
  console.error(`[affected] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
let changedFiles;
try {
  changedFiles = new Set([
    ...readGitLines(['diff', '--name-only', '--diff-filter=ACMRD', `${mergeBase}..HEAD`], repoRoot).map(normalizeRepoPath),
    ...readGitLines(['diff', '--name-only', '--diff-filter=ACMRD'], repoRoot).map(normalizeRepoPath),
    ...readGitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], repoRoot).map(normalizeRepoPath),
    ...readGitLines(['ls-files', '--others', '--exclude-standard'], repoRoot).map(normalizeRepoPath),
  ]);
} catch (error) {
  console.error(`[affected] Git change-set discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let projects;
try {
  projects = await discoverWorkspaceProjects(repoRoot);
} catch (error) {
  console.error(`[affected] Workspace project discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const globalTypecheckFiles = new Set(GLOBAL_TYPECHECK_FILES);
const changedProjectNames = projectsForFiles(projects, changedFiles);
const allProjectNames = new Set(projects.map((project) => project.name));
const rootPackageChange = changedFiles.has('package.json')
  ? classifyRootPackageChange(repoRoot, mergeBase)
  : null;
const workspaceManifestFiles = [...changedFiles].filter(isWorkspacePackageManifestPath);
let workspaceManifestGraph = null;
if (workspaceManifestFiles.length > 0) {
  try {
    workspaceManifestGraph = await validateWorkspaceManifestGraphs(repoRoot, mergeBase, projects);
  } catch (error) {
    console.error(`[affected] Workspace manifest graph validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
const globalTypecheck = [...changedFiles].some((file) => globalTypecheckFiles.has(file))
  || workspaceManifestFiles.length > 0
  || Boolean(rootPackageChange?.requiresGlobalTypecheck);
const affectedProjectNames = globalTypecheck
  ? allProjectNames
  : includeDependents(projects, changedProjectNames);
const configPaths = projectConfigPaths(repoRoot, projects, affectedProjectNames);
const testPlan = createAffectedTestPlan(
  [...changedFiles],
  mergeBase,
  repoRoot,
  { rootPackageChange, workspaceManifestFiles },
);
const appBuildSensitiveFiles = [...changedFiles].filter((file) => (
  isAppBuildSensitivePath(file, affectedProjectNames, rootPackageChange)
));
if (!jsonOnly) {
  console.log(`[affected] base: ${base} (${mergeBase})`);
  console.log(`[affected] files: ${changedFiles.size}`);
  console.log(`[affected] packages: ${[...affectedProjectNames].sort().join(', ') || 'none'}`);
  if (rootPackageChange) console.log(`[affected] package.json classification: ${rootPackageChange.reason}`);
  if (rootPackageChange?.testInvalidatingScriptKeys.length > 0) {
    console.log(`[affected] test-invalidating scripts: ${rootPackageChange.testInvalidatingScriptKeys.join(', ')}`);
  }
  if (workspaceManifestGraph?.pathSetChanged) {
    const { added, removed } = workspaceManifestGraph.pathChanges;
    console.log(`[affected] workspace manifest paths: +${added.length} / -${removed.length}`);
  }
  if (appBuildSensitiveFiles.length > 0) {
    console.log(`[affected] app build-sensitive files: ${appBuildSensitiveFiles.sort().join(', ')}`);
  }
}

const planReport = {
  schemaVersion: 1,
  report: 'affected-verification-plan',
  base,
  mergeBase,
  changedFiles: [...changedFiles].sort(),
  directPackages: [...changedProjectNames].sort(),
  affectedPackages: [...affectedProjectNames].sort(),
  typecheckConfigPaths: configPaths,
  testPlan,
  appBuildSensitiveFiles: [...appBuildSensitiveFiles].sort(),
  appBuildSensitive: appBuildSensitiveFiles.length > 0,
  rootPackageChange: rootPackageChange
    ? {
      reason: rootPackageChange.reason,
      requiresGlobalTypecheck: Boolean(rootPackageChange.requiresGlobalTypecheck),
      testInvalidatingScriptKeys: rootPackageChange.testInvalidatingScriptKeys ?? [],
    }
    : null,
  workspaceManifestFiles: workspaceManifestFiles.sort(),
  workspaceManifestGraph: workspaceManifestGraph
    ? {
      pathSetChanged: Boolean(workspaceManifestGraph.pathSetChanged),
      pathChanges: workspaceManifestGraph.pathChanges,
    }
    : null,
};

if (jsonOnly) {
  console.log(JSON.stringify(planReport, null, 2));
  process.exit(0);
}

if (listOnly) process.exit(0);

if (runTypecheck) {
  if (configPaths.length === 0) console.log('[affected] typecheck skipped: no affected package');
  else runPnpm(['exec', 'tsc', '-b', ...configPaths, '--pretty', 'false']);
}

if (runTests) {
  if (testPlan.fullTests) runPnpm(['exec', 'vitest', 'run']);
  else if (testPlan.explicitSelectorTests.length > 0) {
    runPnpm(['exec', 'vitest', 'run', ...testPlan.explicitSelectorTests]);
  }
  if (!testPlan.fullTests && testPlan.mode === 'changed-fallback') {
    runPnpm(['exec', 'vitest', 'run', `--changed=${mergeBase}`, '--passWithNoTests']);
  } else if (!testPlan.fullTests && testPlan.relatedTestRelevantFiles.length > 0) {
    runPnpm(['exec', 'vitest', 'related', ...testPlan.relatedTestRelevantFiles, '--run', '--passWithNoTests']);
  } else if (!testPlan.fullTests && testPlan.explicitSelectorTests.length === 0) {
    console.log('[affected] tests skipped: no related source or test file');
  }
}

if (runBuildSensitive && appBuildSensitiveFiles.length > 0) {
  console.log(`[affected] build-sensitive verification required for ${appBuildSensitiveFiles.length} file(s)`);
  runPnpm(['run', 'ensure:app-build']);
}
