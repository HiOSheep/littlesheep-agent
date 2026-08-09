import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverWorkspaceProjects,
  includeDependents,
  isWorkspacePackageManifestPath,
  normalizeRepoPath,
  projectConfigPaths,
  projectsForFiles,
  validateWorkspaceManifestGraphs,
} from './workspace-projects.mjs';
import { resolveGitMergeBase } from './lib/affected-verification-base.mjs';
import {
  createAffectedTestPlan,
  classifyRootPackageChange,
  GLOBAL_TYPECHECK_FILES,
  RUNTIME_CONFIG_FILES,
  isAppBuildSensitivePath,
} from './lib/affected-verification-inputs.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalRepoRoot = realpathSync(repoRoot);
const defaultBase = process.env.LITTLESHEEP_BASE_REF || 'origin/main';
const globalTypecheckFiles = new Set(GLOBAL_TYPECHECK_FILES);
const runNames = new Set(['selector', 'typecheck', 'tests', 'affected', 'full', 'build', 'recovery']);

function canonicalPathForBoundary(path) {
  let candidate = resolve(path);
  const missingSegments = [];

  // A destination may not exist yet, so resolve the nearest existing
  // ancestor. Inspect it with lstat first: a dangling symlink must fail
  // closed instead of being treated as an ordinary missing file.
  while (true) {
    let info;
    try {
      info = lstatSync(candidate);
    } catch (error) {
      if (error instanceof Error && !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return candidate;
      missingSegments.push(basename(candidate));
      candidate = parent;
      continue;
    }

    let canonical;
    try {
      canonical = realpathSync(candidate);
    } catch (error) {
      throw new Error(`Cannot resolve path for repository boundary: ${candidate}. ${error instanceof Error ? error.message : String(error)}`);
    }
    if (info.isSymbolicLink() && !existsSync(candidate)) {
      throw new Error(`Cannot resolve symbolic link for repository boundary: ${candidate}.`);
    }
    return missingSegments.length > 0
      ? resolve(canonical, ...missingSegments.reverse())
      : canonical;
  }
}

function isWithinRepo(path) {
  const relativePath = relative(canonicalRepoRoot, canonicalPathForBoundary(path));
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

export function repoRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty path.`);
  }
  const normalized = normalizeRepoPath(value);
  const absolute = resolve(repoRoot, normalized);
  if (!isWithinRepo(absolute)) throw new Error(`${label} must stay inside the repository: ${value}`);
  return normalizeRepoPath(relative(repoRoot, absolute));
}

function splitList(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    sample: 'dirty',
    base: defaultBase,
    files: [],
    packageName: null,
    manifest: null,
    repeat: 1,
    format: 'json',
    output: null,
    run: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--sample') options.sample = nextValue();
    else if (arg.startsWith('--sample=')) options.sample = arg.slice('--sample='.length);
    else if (arg === '--base') options.base = nextValue();
    else if (arg.startsWith('--base=')) options.base = arg.slice('--base='.length);
    else if (arg === '--files') options.files.push(...splitList(nextValue()));
    else if (arg.startsWith('--files=')) options.files.push(...splitList(arg.slice('--files='.length)));
    else if (arg === '--package') options.packageName = nextValue();
    else if (arg.startsWith('--package=')) options.packageName = arg.slice('--package='.length);
    else if (arg === '--manifest') options.manifest = nextValue();
    else if (arg.startsWith('--manifest=')) options.manifest = arg.slice('--manifest='.length);
    else if (arg === '--repeat') options.repeat = Number.parseInt(nextValue(), 10);
    else if (arg.startsWith('--repeat=')) options.repeat = Number.parseInt(arg.slice('--repeat='.length), 10);
    else if (arg === '--format') options.format = nextValue();
    else if (arg.startsWith('--format=')) options.format = arg.slice('--format='.length);
    else if (arg === '--output') options.output = nextValue();
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else if (arg === '--run') options.run = nextValue();
    else if (arg.startsWith('--run=')) options.run = arg.slice('--run='.length);
    else throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
  }

  if (!['dirty', 'single-file', 'single-package', 'manifest'].includes(options.sample)) {
    throw new Error(`Unsupported sample: ${options.sample}.`);
  }
  if (!['json', 'markdown'].includes(options.format)) throw new Error(`Unsupported format: ${options.format}.`);
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 50) {
    throw new Error('--repeat must be an integer from 1 to 50.');
  }
  if (options.run && !runNames.has(options.run)) {
    throw new Error(`Unsupported --run value: ${options.run}. Choose ${[...runNames].join(', ')}.`);
  }
  if (options.sample !== 'dirty' && options.run) {
    throw new Error('--run is only supported for the dirty sample; synthetic samples are dry-run only.');
  }
  if (options.run && options.repeat > 1) {
    throw new Error('--run cannot be combined with --repeat>1 because execution may change build artifacts or caches. Run each executable measurement separately.');
  }
  return options;
}

function usage() {
  return [
    'Measure the affected-verification baseline without changing the worktree.',
    '',
    'Examples:',
    '  pnpm.cmd run measure:verification -- --sample=single-file --files=packages/harness/src/default-harness.ts --repeat=2',
    '  pnpm.cmd run measure:verification -- --sample=single-package --package=@littlesheep/harness --format=markdown',
    '  pnpm.cmd run measure:verification -- --sample=dirty --run=selector --repeat=2',
    '',
    'Samples are dry-run by default. --run may execute selector, typecheck, tests, affected, full, build, or recovery for the dirty tree.',
    'Executable measurements are single-shot; --repeat>1 is reserved for dry-run selection measurements.',
  ].join('\n');
}

function runGit(commandArgs) {
  const result = spawnSync('git', commandArgs, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${commandArgs.join(' ')} failed with exit ${result.status}: ${(result.stderr || '').trim()}`);
  }
  return result.stdout || '';
}

function gitLines(commandArgs) {
  const output = runGit(commandArgs);
  return output.split(/\r?\n/).map(normalizeRepoPath).filter(Boolean);
}

function collectDirtyFiles(baseRef) {
  const mergeBase = resolveGitMergeBase(baseRef, repoRoot);
  const groups = {
    committed: gitLines(['diff', '--name-only', '--diff-filter=ACMRD', `${mergeBase}..HEAD`]),
    unstaged: gitLines(['diff', '--name-only', '--diff-filter=ACMRD']),
    staged: gitLines(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']),
    untracked: gitLines(['ls-files', '--others', '--exclude-standard']),
  };
  return {
    baseRef,
    mergeBase,
    groups,
    files: [...new Set(Object.values(groups).flat())].sort(),
  };
}

function readManifest(manifestPath) {
  const path = resolve(repoRoot, repoRelativePath(manifestPath, 'Manifest path'));
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('The task manifest must contain a JSON object.');
  return parsed;
}

function projectSampleFile(project) {
  const sourceRoot = resolve(project.directory, 'src');
  if (!isWithinRepo(sourceRoot)) {
    throw new Error(`Workspace package ${project.name} has a source directory outside the repository: ${project.relativeDirectory}/src.`);
  }
  const candidates = walkFiles(sourceRoot)
    .filter((path) => /\.(?:[cm]?[jt]sx?|json)$/u.test(path))
    .filter((path) => !/(?:^|[./_-])(test|spec)(?:[./_-]|$)/iu.test(basename(path)))
    .filter((path) => {
      try {
        accessSync(path, fsConstants.R_OK);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
  const sample = candidates[0];
  if (!sample) {
    throw new Error(`Workspace package ${project.name} has no readable non-test source file under ${project.relativeDirectory}/src.`);
  }
  return repoRelativePath(relative(repoRoot, sample), 'Sample package source');
}

function syntheticFiles(options, projects) {
  if (options.sample === 'manifest') {
    if (!options.manifest) throw new Error('--sample=manifest requires --manifest=<path>.');
    const manifest = readManifest(options.manifest);
    const files = Array.isArray(manifest.files) ? manifest.files.map((file) => repoRelativePath(file, 'Manifest file')) : [];
    if (manifest.package && files.length === 0) {
      const project = projects.find((item) => item.name === manifest.package);
      if (!project) throw new Error(`Unknown manifest package: ${manifest.package}.`);
      files.push(projectSampleFile(project));
    }
    if (files.length === 0) throw new Error('The task manifest must provide files or package.');
    return files;
  }

  if (options.sample === 'single-file') {
    if (options.files.length !== 1) throw new Error('--sample=single-file requires exactly one --files=<path>.');
    return options.files.map((file) => repoRelativePath(file, 'Sample file'));
  }

  if (options.sample === 'single-package') {
    if (!options.packageName) throw new Error('--sample=single-package requires --package=<name>.');
    const project = projects.find((item) => item.name === options.packageName);
    if (!project) throw new Error(`Unknown workspace package: ${options.packageName}.`);
    return [projectSampleFile(project)];
  }

  throw new Error(`Cannot create synthetic files for sample ${options.sample}.`);
}

function classifyFile(file, rootPackageChange = null) {
  if (RUNTIME_CONFIG_FILES.includes(file)) return 'runtime-config';
  if (file === 'package.json') {
    if (rootPackageChange?.requiresGlobalTypecheck) return 'global-typecheck-config';
    if (rootPackageChange?.scriptsChanged) return 'verification-script';
  }
  if (globalTypecheckFiles.has(file)) return 'global-typecheck-config';
  if (file === 'vitest.config.ts' || file.startsWith('vitest.config.')) return 'test-config';
  if (file.startsWith('docs/') || file.endsWith('.md')) return 'documentation';
  if (file.startsWith('scripts/')) return 'verification-script';
  if (file.startsWith('packages/app/') && !file.includes('.test.')) return 'app-build-input';
  if (/\.(?:css|html|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|wasm)$/i.test(file)) return 'app-build-sensitive';
  if (file.startsWith('packages/')) return 'package-source';
  return 'other';
}

export function selectTests(
  files,
  base,
  repoRootForCheck = repoRoot,
  {
    rootPackageChange = null,
    workspaceManifestFiles = [],
  } = {},
) {
  const plan = createAffectedTestPlan(files, base, repoRootForCheck, {
    rootPackageChange,
    workspaceManifestFiles,
  });
  return {
    ...plan,
    inputFiles: plan.testRelevantFiles,
    deletedInputFiles: plan.deletedTestInputs,
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function walkFiles(root, result = []) {
  if (!existsSync(root)) return result;
  const info = statSync(root);
  if (info.isFile()) {
    result.push(root);
    return result;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function digestFiles(paths) {
  const entries = [];
  for (const path of [...new Set(paths)].sort()) {
    if (!existsSync(path)) {
      entries.push({ path: normalizeRepoPath(relative(repoRoot, path)), missing: true });
      continue;
    }
    const info = statSync(path);
    if (!info.isFile()) continue;
    const content = readFileSync(path);
    entries.push({
      path: normalizeRepoPath(relative(repoRoot, path)),
      bytes: info.size,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return {
    files: entries.length,
    sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    entries,
  };
}

function buildFingerprints(files) {
  const sourcePaths = [
    ...files.map((file) => resolve(repoRoot, file)),
    ...[...globalTypecheckFiles].map((file) => resolve(repoRoot, file)),
    resolve(repoRoot, 'package.json'),
    resolve(repoRoot, 'vitest.config.ts'),
    resolve(repoRoot, 'packages/app/package.json'),
  ];
  return {
    sourceConfig: digestFiles(sourcePaths),
    buildArtifact: buildArtifactFingerprint(),
  };
}

function buildArtifactFingerprint() {
  const appOut = resolve(repoRoot, 'packages/app/out');
  if (!isWithinRepo(appOut)) {
    return { files: 0, sha256: null, status: 'outside-repository' };
  }
  const artifactFiles = walkFiles(appOut);
  return artifactFiles.length > 0
    ? digestFiles(artifactFiles)
    : { files: 0, sha256: null, status: 'missing' };
}

function compactArtifactFingerprint(value) {
  return {
    files: value.files,
    sha256: value.sha256,
    status: value.status ?? 'present',
  };
}

function artifactFingerprintChanged(left, right) {
  return left.files !== right.files
    || left.sha256 !== right.sha256
    || (left.status ?? 'present') !== (right.status ?? 'present');
}

function cacheClues(projects) {
  const tsBuildInfo = [
    ...['tsconfig.tsbuildinfo', 'tsconfig.web.tsbuildinfo'].map((name) => join(repoRoot, name)),
    ...projects.flatMap((project) => project.tsconfigs.map((config) => join(project.directory, config.replace(/\.json$/u, '.tsbuildinfo')))),
  ].filter((path) => existsSync(path));
  const appOut = resolve(repoRoot, 'packages/app/out');
  return {
    tsBuildInfoFiles: tsBuildInfo.map((path) => normalizeRepoPath(relative(repoRoot, path))).sort(),
    appOutPresent: existsSync(appOut),
  };
}

export async function buildSelection(options) {
  const selectionStartedAt = performance.now();
  const projects = await discoverWorkspaceProjects(repoRoot);
  const dirty = options.sample === 'dirty';
  const gitState = dirty ? collectDirtyFiles(options.base) : null;
  const files = dirty ? gitState.files : syntheticFiles(options, projects).map(normalizeRepoPath).sort();
  const changedProjectNames = projectsForFiles(projects, files);
  const allProjectNames = new Set(projects.map((project) => project.name));
  const workspaceManifestFiles = files.filter(isWorkspacePackageManifestPath);
  const rootPackageChange = files.includes('package.json')
    ? (dirty
      ? classifyRootPackageChange(repoRoot, gitState.mergeBase)
      : {
        available: false,
        requiresGlobalTypecheck: true,
        scriptsChanged: true,
        buildScriptChanged: true,
        testInvalidating: true,
        requiresFullTests: true,
        testInvalidatingScriptKeys: [],
        fullTestScriptKeys: [],
        reason: 'synthetic-package-json-without-baseline',
      })
    : null;
  let workspaceManifestGraph = null;
  if (dirty && workspaceManifestFiles.length > 0) {
    workspaceManifestGraph = await validateWorkspaceManifestGraphs(repoRoot, gitState.mergeBase, projects);
  }
  const globalTypecheck = files.some((file) => globalTypecheckFiles.has(file))
    || workspaceManifestFiles.length > 0;
  const requiresGlobalTypecheck = globalTypecheck || Boolean(rootPackageChange?.requiresGlobalTypecheck);
  const affectedProjectNames = requiresGlobalTypecheck
    ? allProjectNames
    : includeDependents(projects, changedProjectNames);
  const base = gitState?.mergeBase ?? null;
  const testSelection = selectTests(files, base, repoRoot, {
    rootPackageChange,
    workspaceManifestFiles,
  });
  const buildSensitive = files.filter((file) => isAppBuildSensitivePath(file, affectedProjectNames, rootPackageChange));
  const categoryCounts = {};
  for (const file of files) {
    const category = classifyFile(file, rootPackageChange);
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
  }
  const cacheClueSummary = cacheClues(projects);

  // Keep planning separate from hashing the source and generated output. The
  // latter can dominate a dirty-tree sample and must not be mistaken for the
  // selector's own cost.
  const selectionDurationMs = round(performance.now() - selectionStartedAt);
  const fingerprintStartedAt = performance.now();
  const fingerprints = buildFingerprints(files);
  const fingerprintDurationMs = round(performance.now() - fingerprintStartedAt);
  const totalDurationMs = round(performance.now() - selectionStartedAt);

  return {
    sample: options.sample,
    baseRef: options.base,
    mergeBase: base,
    changeGroups: gitState?.groups ?? { synthetic: files },
    changedFiles: files,
    changedFileCount: files.length,
    categoryCounts,
    rootPackageChange,
    workspaceManifestFiles,
    workspaceManifestGraph,
    directPackages: [...changedProjectNames].sort(),
    directPackageCount: changedProjectNames.size,
    affectedPackages: [...affectedProjectNames].sort(),
    affectedPackageCount: affectedProjectNames.size,
    typecheckConfigPaths: projectConfigPaths(repoRoot, projects, affectedProjectNames),
    testSelection,
    appBuildSensitiveFiles: buildSensitive,
    appBuildSensitive: buildSensitive.length > 0,
    cacheClues: cacheClueSummary,
    // `selectionDurationMs` predates the timing split and remains the
    // compatibility field for planning-only duration.
    selectionDurationMs,
    fingerprintDurationMs,
    totalDurationMs,
    timing: {
      planningDurationMs: selectionDurationMs,
      fingerprintDurationMs,
      totalDurationMs,
    },
    fingerprints,
  };
}

export function commandFor(runName, base) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  if (runName === 'selector') return { command: process.execPath, args: ['scripts/run-affected-verification.mjs', '--list', `--base=${base}`] };
  const scripts = {
    typecheck: 'typecheck:changed',
    tests: 'test:changed',
    affected: 'verify:changed',
    full: 'verify:full',
    build: 'build:app',
    recovery: 'verify:app-recovery',
  };
  return { command: pnpm, args: ['run', scripts[runName]] };
}

export function spawnInvocation(command, args) {
  if (process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')) {
    const comSpec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', command, ...args],
      displayCommand: [command, ...args],
    };
  }
  return { command, args, displayCommand: [command, ...args] };
}

function summarizeOutput(value, limit = 2400) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n...[truncated]...\n${text.slice(-half)}`;
}

export function classifyCommandStatus(runName, result, stdout = '', stderr = '') {
  if (result.error || result.signal || result.status !== 0) return 'failed';

  const output = `${stdout}\n${stderr}`;
  const skipMarkers = {
    typecheck: 'typecheck skipped: no affected package',
    tests: 'tests skipped: no related source or test file',
  };
  const marker = skipMarkers[runName];
  return marker && output.toLowerCase().includes(marker) ? 'skipped' : 'executed';
}

function runMeasured(runName, base) {
  const logical = commandFor(runName, base);
  const invocation = spawnInvocation(logical.command, logical.args);
  const startedAt = performance.now();
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      ...(base ? { LITTLESHEEP_BASE_REF: base } : {}),
    },
  });
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const status = classifyCommandStatus(runName, result, stdout, stderr);
  const actualArgv = [invocation.command, ...invocation.args];
  return {
    name: runName,
    command: invocation.displayCommand.join(' '),
    argv: actualArgv,
    actualArgv,
    durationMs: round(performance.now() - startedAt),
    status,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error ? String(result.error.message ?? result.error) : null,
    stdout: summarizeOutput(stdout),
    stderr: summarizeOutput(stderr),
  };
}

export async function createReport(options) {
  const repetitions = [];
  for (let index = 0; index < options.repeat; index += 1) {
    const repetitionStartedAt = performance.now();
    const selection = await buildSelection(options);
    const preRunArtifact = compactArtifactFingerprint(selection.fingerprints.buildArtifact);
    const command = options.run ? runMeasured(options.run, selection.mergeBase ?? options.base) : null;
    const postRunArtifact = command ? compactArtifactFingerprint(buildArtifactFingerprint()) : null;
    const totalDurationMs = round(performance.now() - repetitionStartedAt);
    repetitions.push({
      iteration: index + 1,
      // Compatibility alias: this is planning-only, while the selection's
      // fingerprint and combined timings are available below.
      selectionDurationMs: selection.selectionDurationMs,
      fingerprintDurationMs: selection.fingerprintDurationMs,
      selectionTotalDurationMs: selection.totalDurationMs,
      commandDurationMs: command?.durationMs ?? null,
      totalDurationMs,
      selection,
      command,
      buildArtifactEvidence: {
        preRun: preRunArtifact,
        postRun: postRunArtifact,
        changedByCommand: postRunArtifact ? artifactFingerprintChanged(preRunArtifact, postRunArtifact) : null,
      },
    });
  }
  return {
    schemaVersion: 1,
    report: 'verification-baseline',
    generatedAt: new Date().toISOString(),
    repository: 'littlesheep',
    options: {
      sample: options.sample,
      base: options.base,
      repeat: options.repeat,
      run: options.run,
    },
    repetitions,
  };
}

export function renderMarkdown(report) {
  const rows = report.repetitions.map((entry) => {
    const selection = entry.selection;
    const command = entry.command;
    return `| ${entry.iteration} | ${entry.selectionDurationMs} | ${entry.fingerprintDurationMs} | ${entry.selectionTotalDurationMs} | ${entry.commandDurationMs ?? '-'} | ${entry.totalDurationMs} | ${selection.changedFileCount} | ${selection.directPackageCount} | ${selection.affectedPackageCount} | ${selection.testSelection.mode} | ${selection.testSelection.fullTests ? 'yes' : 'no'} | ${selection.appBuildSensitive ? 'yes' : 'no'} | ${command?.status ?? 'dry-run'} |`;
  });
  const first = report.repetitions[0]?.selection;
  const artifactEvidence = report.repetitions[0]?.buildArtifactEvidence;
  const firstCommand = report.repetitions[0]?.command;
  return [
    '# Verification Baseline',
    '',
    `Generated: ${report.generatedAt}`,
    `Sample: ${report.options.sample}`,
    `Base: ${report.options.base}`,
    `Merge-base: ${first?.mergeBase ?? 'synthetic'}`,
    '',
    '| Iteration | Planning ms | Fingerprint ms | Selection total ms | Command ms | Total ms | Files | Direct packages | Affected packages | Mode | Full tests | App build-sensitive | Status |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |',
    ...rows,
    '',
    `Changed categories: ${JSON.stringify(first?.categoryCounts ?? {})}`,
    `Full tests: ${first?.testSelection?.fullTests ?? false}`,
    `Explicit selector tests: ${JSON.stringify(first?.testSelection?.explicitSelectorTests ?? [])}`,
    `Related test-relevant files: ${JSON.stringify(first?.testSelection?.relatedTestRelevantFiles ?? [])}`,
    `Deleted test inputs: ${JSON.stringify(first?.testSelection?.deletedTestInputs ?? [])}`,
    `Fallback reasons: ${JSON.stringify(first?.testSelection?.fallbackReasons ?? [])}`,
    `Actual argv: ${JSON.stringify(firstCommand?.actualArgv ?? [])}`,
    `Command status: ${firstCommand?.status ?? 'dry-run'}`,
    `Build artifact fingerprint before command: ${artifactEvidence?.preRun?.sha256 ?? 'missing'}`,
    `Build artifact fingerprint after command: ${artifactEvidence?.postRun?.sha256 ?? 'not-run'}`,
    `Build artifact changed by command: ${artifactEvidence?.changedByCommand ?? 'not-run'}`,
  ].join('\n') + '\n';
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const report = await createReport(options);
  const output = options.format === 'markdown' ? renderMarkdown(report) : `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) writeFileSync(resolve(repoRoot, repoRelativePath(options.output, 'Output path')), output, 'utf8');
  else process.stdout.write(output);
  if (report.repetitions.some((entry) => entry.command?.status === 'failed')) process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[verification-baseline] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
