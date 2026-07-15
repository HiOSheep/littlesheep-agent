import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverWorkspaceProjects,
  includeDependents,
  normalizeRepoPath,
  projectConfigPaths,
  projectsForFiles,
} from './workspace-projects.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const baseArg = process.argv.find((value) => value.startsWith('--base='));
const base = baseArg?.slice('--base='.length) || process.env.LITTLESHEEP_BASE_REF || 'origin/main';
const runTypecheck = !args.has('--tests-only');
const runTests = !args.has('--typecheck-only');
const listOnly = args.has('--list');
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

function gitLines(commandArgs, allowFailure = false) {
  const output = run('git', commandArgs, { capture: true, allowFailure });
  return output ? output.split(/\r?\n/).map(normalizeRepoPath).filter(Boolean) : [];
}

const mergeBase = run('git', ['merge-base', base, 'HEAD'], { capture: true, allowFailure: true }) || 'HEAD';
const changedFiles = new Set([
  ...gitLines(['diff', '--name-only', '--diff-filter=ACMRD', `${mergeBase}..HEAD`], true),
  ...gitLines(['diff', '--name-only', '--diff-filter=ACMRD'], true),
  ...gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMRD'], true),
  ...gitLines(['ls-files', '--others', '--exclude-standard'], true),
]);

const projects = await discoverWorkspaceProjects(repoRoot);
const globalTypecheckFiles = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.workspace.json',
]);
const changedProjectNames = projectsForFiles(projects, changedFiles);
const allProjectNames = new Set(projects.map((project) => project.name));
const affectedProjectNames = [...changedFiles].some((file) => globalTypecheckFiles.has(file))
  ? allProjectNames
  : includeDependents(projects, changedProjectNames);
const configPaths = projectConfigPaths(repoRoot, projects, affectedProjectNames);
const testRelevantFiles = [...changedFiles].filter((file) => {
  if (!/^(packages|scripts|test)\/.*\.(?:[cm]?[jt]sx?|json)$/.test(file)) return false;
  return !/(?:^|\/)(?:package|tsconfig(?:\.[^/]+)?)\.json$/.test(file);
});
const fullTests = changedFiles.has('vitest.config.ts');
const hasDeletedTestInput = testRelevantFiles.some((file) => !existsSync(resolve(repoRoot, file)));

console.log(`[affected] base: ${base} (${mergeBase})`);
console.log(`[affected] files: ${changedFiles.size}`);
console.log(`[affected] packages: ${[...affectedProjectNames].sort().join(', ') || 'none'}`);

if (listOnly) process.exit(0);

if (runTypecheck) {
  if (configPaths.length === 0) console.log('[affected] typecheck skipped: no affected package');
  else runPnpm(['exec', 'tsc', '-b', ...configPaths, '--pretty', 'false']);
}

if (runTests) {
  if (fullTests) runPnpm(['test']);
  else if (testRelevantFiles.length === 0) console.log('[affected] tests skipped: no related source or test file');
  else if (hasDeletedTestInput || testRelevantFiles.length > 100) {
    runPnpm(['exec', 'vitest', 'run', `--changed=${base}`, '--passWithNoTests']);
  } else {
    runPnpm(['exec', 'vitest', 'related', ...testRelevantFiles, '--run', '--passWithNoTests']);
  }
}
