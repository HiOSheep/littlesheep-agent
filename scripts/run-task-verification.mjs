import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWorkspaceProjects, projectConfigPaths, projectsForFiles } from './workspace-projects.mjs';
import { writeVerificationReport } from './run-verification-gate.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultReportDirectory = resolve(repoRoot, '.codex_tmp', 'verification-reports', 'task');

function normalizePath(value) {
  return String(value).replace(/\\/g, '/').replace(/^\.\//u, '');
}

function ensureRepoPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must not be empty.`);
  const absolute = resolve(repoRoot, value);
  const path = relative(repoRoot, absolute);
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside the repository: ${value}`);
  }
  return normalizePath(path);
}

function splitList(value) {
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  return value;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    files: [],
    packageName: null,
    manifest: null,
    tests: true,
    typecheck: true,
    appWebTypecheck: false,
    packageTests: false,
    watch: false,
    list: false,
    reportDirectory: defaultReportDirectory,
    output: null,
    keep: 5,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === '--' || arg === '') continue;
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--watch') options.watch = true;
    else if (arg === '--tests-only') { options.tests = true; options.typecheck = false; options.appWebTypecheck = false; options.packageTests = true; }
    else if (arg === '--typecheck-only') { options.tests = false; options.typecheck = true; options.appWebTypecheck = false; }
    else if (arg === '--no-tests') options.tests = false;
    else if (arg === '--no-typecheck') { options.typecheck = false; options.appWebTypecheck = false; }
    else if (arg === '--app-web-typecheck') options.appWebTypecheck = true;
    else if (arg === '--no-app-web-typecheck') options.appWebTypecheck = false;
    else if (arg === '--package-tests') options.packageTests = true;
    else if (arg === '--files') options.files.push(...splitList(next()));
    else if (arg.startsWith('--files=')) options.files.push(...splitList(arg.slice('--files='.length)));
    else if (arg === '--package') options.packageName = next();
    else if (arg.startsWith('--package=')) options.packageName = arg.slice('--package='.length);
    else if (arg === '--manifest') options.manifest = next();
    else if (arg.startsWith('--manifest=')) options.manifest = arg.slice('--manifest='.length);
    else if (arg === '--report-dir') options.reportDirectory = next();
    else if (arg.startsWith('--report-dir=')) options.reportDirectory = arg.slice('--report-dir='.length);
    else if (arg === '--output') options.output = next();
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else if (arg === '--keep') options.keep = Number.parseInt(next(), 10);
    else if (arg.startsWith('--keep=')) options.keep = Number.parseInt(arg.slice('--keep='.length), 10);
    else throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
  }
  if (options.files.length > 0 && options.packageName) throw new Error('Use --files or --package, not both.');
  if (options.manifest && (options.files.length > 0 || options.packageName)) throw new Error('Use --manifest alone.');
  if (!Number.isInteger(options.keep) || options.keep < 1 || options.keep > 50) throw new Error('--keep must be an integer from 1 to 50.');
  if (!options.help && !options.manifest && options.files.length === 0 && !options.packageName) {
    throw new Error('Provide --files=<path>, --package=<name>, or --manifest=<path>.');
  }
  if (options.watch && !options.tests) throw new Error('--watch requires tests.');
  return options;
}

function readTaskManifest(path) {
  const manifestPath = ensureRepoPath(path, 'Manifest path');
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read task manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Task manifest must contain a JSON object.');
  if (value.files !== undefined && !Array.isArray(value.files)) throw new Error('Task manifest files must be an array.');
  if (value.tests !== undefined && !Array.isArray(value.tests)) throw new Error('Task manifest tests must be an array.');
  if (value.package !== undefined && typeof value.package !== 'string') throw new Error('Task manifest package must be a string.');
  for (const key of ['typecheck', 'appWebTypecheck', 'watch']) {
    if (value[key] !== undefined) parseBoolean(value[key], `Task manifest ${key}`);
  }
  if ((!value.files || value.files.length === 0) && !value.package) throw new Error('Task manifest must provide files or package.');
  if (Array.isArray(value.files) && value.files.length > 0 && value.package) throw new Error('Task manifest must use files or package, not both.');
  return { path: manifestPath, value };
}

function walkFiles(root, result = []) {
  if (!existsSync(root)) return result;
  const info = lstatSync(root);
  if (info.isFile()) { result.push(root); return result; }
  if (!info.isDirectory()) return result;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function testFile(path) {
  return /(?:^|[./_-])(test|spec)\.(?:[cm]?[jt]sx?|mjs)$/iu.test(path);
}

function sourceFile(path) {
  return /\.(?:[cm]?[jt]sx?|mjs)$/u.test(path) && !testFile(path);
}

function directTestCandidates(file) {
  const normalized = normalizePath(file);
  const extension = normalized.match(/\.[^.]+$/u)?.[0] ?? '';
  const stem = normalized.slice(0, normalized.length - extension.length);
  return [`${stem}.test${extension}`, `${stem}.spec${extension}`];
}

function directTestsForFiles(files) {
  const directTests = new Set();
  const relatedSources = [];
  for (const file of files) {
    if (testFile(file)) {
      directTests.add(file);
      continue;
    }
    const candidate = directTestCandidates(file).find((path) => existsSync(resolve(repoRoot, path)));
    if (candidate) directTests.add(candidate);
    else if (sourceFile(file)) relatedSources.push(file);
  }
  return {
    directTests: [...directTests].sort(),
    relatedSources: relatedSources.sort(),
  };
}

function packageTests(project) {
  return walkFiles(project.directory)
    .filter((path) => testFile(path))
    .map((path) => normalizePath(relative(repoRoot, path)))
    .sort();
}

function packageForName(projects, name) {
  const project = projects.find((item) => item.name === name);
  if (!project) throw new Error(`Unknown workspace package: ${name}.`);
  return project;
}

function typecheckPathsForFiles(projects, files) {
  const paths = [];
  for (const project of projects) {
    const projectFiles = files.filter((file) => file === project.relativeDirectory || file.startsWith(`${project.relativeDirectory}/`));
    if (projectFiles.length === 0) continue;
    if (project.name !== '@littlesheep/app') {
      paths.push(...projectConfigPaths(repoRoot, projects, new Set([project.name])));
      continue;
    }
    const renderer = projectFiles.some((file) => file.startsWith('packages/app/src/renderer/'));
    const main = projectFiles.some((file) => file.startsWith('packages/app/src/main/') || file.startsWith('packages/app/src/preload/'));
    const shared = projectFiles.some((file) => file.startsWith('packages/app/src/shared/'));
    if (renderer || shared) paths.push('packages/app/tsconfig.web.json');
    if (main || shared) paths.push('packages/app/tsconfig.json');
  }
  return [...new Set(paths)].sort();
}

function taskTestPlan(files, packageProject, explicitTests, tests) {
  if (!tests) return { mode: 'skip', directTests: [], relatedSources: [], packageTests: [], reason: 'tests disabled' };
  if (explicitTests.length > 0) return { mode: 'explicit', directTests: explicitTests, relatedSources: [], packageTests: [], reason: null };
  if (packageProject) {
    const filesForPackage = packageTests(packageProject);
    return { mode: filesForPackage.length > 0 ? 'package' : 'skip', directTests: [], relatedSources: [], packageTests: filesForPackage, reason: filesForPackage.length > 0 ? null : 'no package tests' };
  }
  const direct = directTestsForFiles(files);
  const directTests = direct.directTests;
  const relatedSources = direct.relatedSources;
  return {
    mode: directTests.length > 0 && relatedSources.length > 0 ? 'mixed'
      : directTests.length > 0 ? 'explicit'
        : relatedSources.length > 0 ? 'related' : 'skip',
    directTests,
    relatedSources,
    packageTests: [],
    reason: directTests.length > 0 || relatedSources.length > 0 ? null : 'no testable task input',
  };
}

export async function createTaskPlan(options) {
  const projects = await discoverWorkspaceProjects(repoRoot);
  let manifest = null;
  if (options.manifest) manifest = readTaskManifest(options.manifest);
  const value = manifest?.value ?? {};
  const files = [...new Set([...(manifest ? value.files ?? [] : options.files)].map((file) => ensureRepoPath(file, 'Task file')))].sort();
  const packageName = manifest?.value?.package ?? options.packageName;
  const packageProject = packageName ? packageForName(projects, packageName) : null;
  const taskFiles = packageProject ? [packageProject.relativeDirectory] : files;
  for (const file of files) {
    const absolute = resolve(repoRoot, file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`Task file does not exist: ${file}.`);
  }
  const explicitTests = [...new Set((manifest?.value?.tests ?? []).map((file) => ensureRepoPath(file, 'Task test')))].sort();
  for (const file of explicitTests) {
    if (!existsSync(resolve(repoRoot, file))) throw new Error(`Task test does not exist: ${file}.`);
  }
  const directProjects = packageProject ? new Set([packageProject.name]) : projectsForFiles(projects, files);
  const typecheck = manifest?.value?.typecheck ?? options.typecheck;
  const appWebTypecheck = manifest?.value?.appWebTypecheck ?? options.appWebTypecheck;
  const typecheckConfigPaths = typecheck
    ? packageProject
      ? projectConfigPaths(repoRoot, projects, new Set([packageProject.name]))
      : typecheckPathsForFiles(projects, files)
    : [];
  const rendererInput = taskFiles.some((file) => file.startsWith('packages/app/src/renderer/'));
  const sharedInput = taskFiles.some((file) => file.startsWith('packages/app/src/shared/'));
  const webTypecheck = Boolean(appWebTypecheck || rendererInput || sharedInput) && typecheck;
  const filteredTypecheckPaths = webTypecheck
    ? typecheckConfigPaths.filter((path) => path !== 'packages/app/tsconfig.web.json')
    : typecheckConfigPaths;
  const packageTestsEnabled = Boolean(manifest?.value?.tests !== undefined || options.packageTests);
  const testPlan = taskTestPlan(
    files,
    packageProject,
    explicitTests,
    packageProject && !packageTestsEnabled ? false : (manifest?.value?.tests !== undefined ? true : options.tests),
  );
  if (!options.list && !testPlan.directTests.length && !testPlan.relatedSources.length
    && !testPlan.packageTests.length && typecheckConfigPaths.length === 0 && !webTypecheck) {
    throw new Error('Task has no executable test or typecheck input; provide a source file, package, or manifest tests.');
  }
  return {
    schemaVersion: 1,
    report: 'task-verification-plan',
    task: { files, package: packageName, manifest: manifest?.path ?? null },
    directPackages: [...directProjects].sort(),
    testPlan,
    typecheck: Boolean(typecheck),
    typecheckConfigPaths: [...new Set(filteredTypecheckPaths)].sort(),
    appWebTypecheck: webTypecheck,
    appWebTypecheckPath: webTypecheck ? 'packages/app/tsconfig.web.json' : null,
    watch: Boolean(manifest?.value?.watch ?? options.watch),
  };
}

function pnpmCommand(args) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command, ...args], display: [command, ...args] };
  }
  return { command, args, display: [command, ...args] };
}

function runCommands(commands, { watch = false } = {}) {
  let stdout = '';
  let stderr = '';
  let status = 0;
  let signal = null;
  let error = null;
  const labels = [];
  const startedAt = performance.now();
  for (const spec of commands) {
    labels.push(spec.display.join(' '));
    const result = spawnSync(spec.command, spec.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: watch ? 'inherit' : 'pipe',
      env: process.env,
    });
    stdout += String(result.stdout ?? '');
    stderr += String(result.stderr ?? '');
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.signal || result.status !== 0) {
      status = result.status ?? 1;
      signal = result.signal ?? null;
      error = result.error ?? null;
      break;
    }
    if (watch) break;
  }
  return { status, signal, error, stdout, stderr, durationMs: Math.round((performance.now() - startedAt) * 100) / 100, command: labels.join(' && ') };
}

function stage(name, status = 'planned', reason = null) {
  return { name, status, reason, exitCode: null, signal: null, durationMs: 0, command: null, stdout: '', stderr: '', details: {} };
}

function recordStage(stages, name, result, details = {}) {
  const item = stages.find((entry) => entry.name === name);
  const failed = result.error || result.signal || result.status !== 0;
  if (!item) return failed;
  item.status = failed ? 'failed' : 'executed';
  item.reason = failed ? (result.error?.message ?? (result.signal ? `terminated by ${result.signal}` : `exit code ${result.status}`)) : null;
  item.exitCode = result.status ?? null;
  item.signal = result.signal ?? null;
  item.durationMs = result.durationMs;
  item.command = result.command;
  item.stdout = String(result.stdout ?? '').trim().slice(-4000);
  item.stderr = String(result.stderr ?? '').trim().slice(-4000);
  item.details = details;
  return failed;
}

function testCommands(plan) {
  const commands = [];
  if (plan.testPlan.mode === 'explicit' || plan.testPlan.mode === 'package' || plan.testPlan.mode === 'mixed') {
    const files = plan.testPlan.mode === 'package' ? plan.testPlan.packageTests : plan.testPlan.directTests;
    if (files.length > 0) commands.push(pnpmCommand(['exec', 'vitest', ...(plan.watch ? [] : ['run']), ...files]));
  }
  if (plan.testPlan.mode === 'related' || plan.testPlan.mode === 'mixed') {
    if (plan.testPlan.relatedSources.length > 0) {
      const args = ['exec', 'vitest', 'related', ...plan.testPlan.relatedSources, '--passWithNoTests'];
      if (!plan.watch) args.push('--run');
      commands.push(pnpmCommand(args));
    }
  }
  return commands;
}

function typecheckCommands(plan) {
  return plan.typecheckConfigPaths.map((path) => pnpmCommand(['exec', 'tsc', '--noEmit', '-p', path, '--pretty', 'false']));
}

export async function runTaskVerification({ options = parseArgs(), execute = runCommands, reportDirectory = defaultReportDirectory, output = null, keep = 5 } = {}) {
  const startedAt = new Date();
  const timerStartedAt = performance.now();
  const stages = [stage('selector'), stage('tests'), stage('typecheck'), stage('app-web-typecheck')];
  let plan = null;
  let failedStage = null;
  try {
    plan = await createTaskPlan(options);
    const selector = stages[0];
    selector.status = 'executed';
    selector.durationMs = Math.round((performance.now() - timerStartedAt) * 100) / 100;
    selector.command = 'task plan (explicit boundary)';
    selector.details = plan;
    if (options.list) {
      stages.slice(1).forEach((item) => { item.status = 'skipped'; item.reason = 'list-only'; });
    } else {
      if (plan.testPlan.mode === 'skip') { stages[1].status = 'skipped'; stages[1].reason = plan.testPlan.reason; }
      else if (recordStage(stages, 'tests', await execute(testCommands(plan), { watch: plan.watch }), { testPlan: plan.testPlan })) failedStage = 'tests';
      if (!failedStage && plan.typecheckConfigPaths.length === 0) { stages[2].status = 'skipped'; stages[2].reason = 'no task typecheck input'; }
      else if (!failedStage && recordStage(stages, 'typecheck', await execute(typecheckCommands(plan)), { configPaths: plan.typecheckConfigPaths })) failedStage = 'typecheck';
      if (!failedStage && !plan.appWebTypecheck) { stages[3].status = 'skipped'; stages[3].reason = 'not required for task input'; }
      else if (!failedStage && recordStage(stages, 'app-web-typecheck', await execute([pnpmCommand(['exec', 'tsc', '--noEmit', '-p', 'packages/app/tsconfig.web.json', '--pretty', 'false'])]), { configPath: 'packages/app/tsconfig.web.json' })) failedStage = 'app-web-typecheck';
    }
  } catch (error) {
    failedStage = 'selector';
    stages[0].status = 'failed';
    stages[0].reason = error instanceof Error ? error.message : String(error);
    stages.slice(1).forEach((item) => { item.status = 'skipped'; item.reason = 'blocked by failed stage selector'; });
  }
  const finishedAt = new Date();
  const report = {
    schemaVersion: 1,
    report: 'task-verification',
    status: failedStage ? 'failed' : 'passed',
    failedStage,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.round((performance.now() - timerStartedAt) * 100) / 100,
    plan,
    stages,
  };
  const persisted = await writeVerificationReport(report, { reportDirectory, output, keep });
  console.log(`[task] ${persisted.status}${failedStage ? ` failedStage=${failedStage}` : ''} duration=${persisted.durationMs}ms report=${persisted.reportPath}`);
  return persisted;
}

function usage() {
  return [
    'Run a task-scoped verification without reading Git history or unrelated dirty files.',
    '',
    'Usage:',
    '  pnpm.cmd run verify:task -- --files=packages/harness/src/continuation-intent.ts',
    '  pnpm.cmd run verify:task -- --package=@littlesheep/runner --typecheck-only',
    '  pnpm.cmd run verify:task -- --files=packages/app/src/renderer/composer/input-size.ts',
    '  pnpm.cmd run verify:task -- --manifest=.codex_tmp/task.json',
    '',
    'Options: --files=<path>[,<path>] --package=<name> --package-tests --manifest=<path> --tests-only --typecheck-only --watch --list --app-web-typecheck --report-dir=<path> --output=<path> --keep=<n>',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(`[task] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; return; }
  if (options.help) { console.log(usage()); return; }
  const report = await runTaskVerification({ options, reportDirectory: options.reportDirectory, output: options.output, keep: options.keep });
  if (report.status === 'failed') process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`[task] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
