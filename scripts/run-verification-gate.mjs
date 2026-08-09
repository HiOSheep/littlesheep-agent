import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultReportDirectory = resolve(repoRoot, '.codex_tmp', 'verification-reports');
const gateNames = new Set(['changed', 'core', 'full']);
const stageOrder = Object.freeze({
  changed: ['check:repo', 'selector', 'typecheck', 'tests', 'build', 'recovery'],
  core: ['check:repo', 'selector', 'typecheck', 'tests', 'build', 'recovery'],
  full: ['check:repo', 'selector', 'tests', 'typecheck', 'build', 'recovery'],
});

function normalizeArgs(argv) {
  return argv.filter((value) => value !== '--');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    gate: 'changed',
    base: process.env.LITTLESHEEP_BASE_REF || 'origin/main',
    reportDirectory: defaultReportDirectory,
    output: null,
  keep: 5,
  list: false,
  help: false,
  };
  const args = normalizeArgs(argv);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--gate') options.gate = next();
    else if (arg.startsWith('--gate=')) options.gate = arg.slice('--gate='.length);
    else if (arg === '--base') options.base = next();
    else if (arg.startsWith('--base=')) options.base = arg.slice('--base='.length);
    else if (arg === '--report-dir') options.reportDirectory = next();
    else if (arg.startsWith('--report-dir=')) options.reportDirectory = arg.slice('--report-dir='.length);
    else if (arg === '--output') options.output = next();
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else if (arg === '--keep') options.keep = Number.parseInt(next(), 10);
    else if (arg.startsWith('--keep=')) options.keep = Number.parseInt(arg.slice('--keep='.length), 10);
    else throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
  }
  if (!gateNames.has(options.gate)) throw new Error(`Unsupported gate: ${options.gate}. Choose changed, core, or full.`);
  if (!Number.isInteger(options.keep) || options.keep < 1 || options.keep > 50) {
    throw new Error('--keep must be an integer from 1 to 50.');
  }
  if (typeof options.base !== 'string' || options.base.trim() === '') throw new Error('--base must not be empty.');
  return options;
}

function ensureRepoRelativePath(value, label) {
  const absolute = resolve(repoRoot, value);
  const relativePath = relative(repoRoot, absolute);
  if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} must stay inside the repository: ${value}`);
  }
  return absolute;
}

function invocationFor(command, args) {
  if (process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')) {
    const comSpec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', command, ...args],
      display: [command, ...args],
    };
  }
  return { command, args, display: [command, ...args] };
}

function pnpmCommand(args) {
  return invocationFor(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args);
}

function summarize(value, limit = 4000) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n...[truncated]...\n${text.slice(-half)}`;
}

function extractJson(text) {
  const source = String(text ?? '').trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    const lines = source.split(/\r?\n/u).reverse();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
      try {
        return JSON.parse(trimmed);
      } catch {
        // Keep looking for the final JSON object in mixed command output.
      }
    }
  }
  return null;
}

export function classifyStageStatus(result, stageName = '') {
  if (result?.error || result?.signal || result?.status !== 0) return 'failed';
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.toLowerCase();
  if (stageName === 'typecheck' && output.includes('typecheck skipped: no affected package')) return 'skipped';
  if (stageName === 'tests' && output.includes('tests skipped: no related source or test file')) return 'skipped';
  return 'executed';
}

function plannedStage(name, reason = null) {
  return {
    name,
    status: reason ? 'skipped' : 'planned',
    reason,
    exitCode: null,
    signal: null,
    durationMs: 0,
    command: null,
    stdout: '',
    stderr: '',
    details: {},
  };
}

function failedReason(result) {
  if (result?.error) return result.error.message ?? String(result.error);
  if (result?.signal) return `terminated by ${result.signal}`;
  return `exit code ${result?.status ?? 'unknown'}`;
}

export function summarizeGateReport(report) {
  const failed = report.failedStage ? ` failedStage=${report.failedStage}` : '';
  const counts = report.stages.reduce((accumulator, stage) => {
    accumulator[stage.status] = (accumulator[stage.status] ?? 0) + 1;
    return accumulator;
  }, {});
  const countText = ['executed', 'skipped', 'failed', 'planned']
    .filter((key) => counts[key])
    .map((key) => `${key}=${counts[key]}`)
    .join(' ');
  return `[gate] ${report.gate} ${report.status}${failed} duration=${report.durationMs}ms ${countText} report=${report.reportPath}`;
}

async function atomicJsonWrite(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeVerificationReport(report, {
  reportDirectory = defaultReportDirectory,
  output = null,
  keep = 5,
} = {}) {
  const directory = ensureRepoRelativePath(reportDirectory, 'Verification report directory');
  await mkdir(directory, { recursive: true });
  const historyPath = join(directory, `${Date.now()}-${process.pid}.json`);
  const latestPath = output ? ensureRepoRelativePath(output, 'Verification report output') : join(directory, 'latest.json');
  await mkdir(dirname(latestPath), { recursive: true });
  const withPaths = {
    ...report,
    reportPath: latestPath,
    historyPath,
  };
  await atomicJsonWrite(historyPath, withPaths);
  await atomicJsonWrite(latestPath, withPaths);

  const historyFiles = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d+-\d+\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const stale of historyFiles.slice(keep)) await rm(join(directory, stale), { force: true });
  return withPaths;
}

function commandLabel(command, args) {
  return [command, ...args].join(' ');
}

async function defaultExecute({ command, args, commands: commandList = null, env }) {
  const startedAt = performance.now();
  const commands = command ? [{ command, args }] : [];
  const allCommands = [...(commandList ?? commands)];
  let status = 0;
  let signal = null;
  let error = null;
  let stdout = '';
  let stderr = '';
  const labels = [];
  for (const item of allCommands) {
    const invocation = invocationFor(item.command, item.args);
    labels.push(commandLabel(item.command, item.args));
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, ...env },
    });
    const itemStdout = String(result.stdout ?? '');
    const itemStderr = String(result.stderr ?? '');
    stdout += itemStdout;
    stderr += itemStderr;
    if (itemStdout) process.stdout.write(itemStdout);
    if (itemStderr) process.stderr.write(itemStderr);
    if (result.error || result.status !== 0 || result.signal) {
      status = result.status ?? 1;
      signal = result.signal ?? null;
      error = result.error ?? null;
      break;
    }
  }
  return {
    status,
    signal,
    error,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    stdout,
    stderr,
    command: labels.join(' && '),
  };
}

async function runCommandStage(stages, name, spec, execute, details = {}) {
  const index = stages.findIndex((stage) => stage.name === name);
  if (index < 0) throw new Error(`Unknown verification stage: ${name}`);
  const startedAt = performance.now();
  let result;
  try {
    result = await execute(spec);
  } catch (error) {
    result = {
      status: 1,
      signal: null,
      error,
      stdout: '',
      stderr: '',
      command: spec.command ? commandLabel(spec.command, spec.args) : (spec.commands ?? []).map((item) => commandLabel(item.command, item.args)).join(' && '),
    };
  }
  const status = classifyStageStatus(result, name);
  stages[index] = {
    ...stages[index],
    status,
    reason: status === 'failed' ? failedReason(result) : null,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    durationMs: result.durationMs ?? Math.round((performance.now() - startedAt) * 100) / 100,
    command: result.command ?? (spec.command ? commandLabel(spec.command, spec.args) : (spec.commands ?? []).map((item) => commandLabel(item.command, item.args)).join(' && ')),
    stdout: summarize(result.stdout),
    stderr: summarize(result.stderr),
    details: { ...stages[index].details, ...details },
  };
  return { status, result, index };
}

function markSkipped(stages, name, reason, details = {}) {
  const index = stages.findIndex((stage) => stage.name === name);
  if (index < 0) return;
  if (stages[index].status !== 'planned') return;
  stages[index] = {
    ...stages[index],
    status: 'skipped',
    reason,
    details: { ...stages[index].details, ...details },
  };
}

function markBlocked(stages, fromIndex, reason) {
  for (let index = fromIndex; index < stages.length; index += 1) {
    if (stages[index].status !== 'planned') continue;
    stages[index] = { ...stages[index], status: 'skipped', reason };
  }
}

function selectorCommand(base) {
  return {
    command: process.execPath,
    args: ['scripts/run-affected-verification.mjs', '--list', '--json', `--base=${base}`],
  };
}

function gateCommand(name, base) {
  const commands = {
    'check:repo': pnpmCommand(['run', 'check:repo']),
    'core:typecheck': pnpmCommand(['run', 'typecheck']),
    'core:tests': pnpmCommand(['run', 'test:core-eval']),
    'full:tests': pnpmCommand(['run', 'test']),
    'full:typecheck': pnpmCommand(['run', 'typecheck']),
    'full:build': pnpmCommand(['run', 'build:app']),
    recovery: pnpmCommand(['run', 'verify:app-recovery']),
  };
  if (name === 'selector') return selectorCommand(base);
  const key = name.includes(':') ? name : name;
  const invocation = commands[key];
  if (!invocation) throw new Error(`No command configured for ${name}`);
  return invocation;
}

function affectedTypecheckCommand(selection) {
  return pnpmCommand(['exec', 'tsc', '-b', ...selection.typecheckConfigPaths, '--pretty', 'false']);
}

function affectedTestCommands(selection) {
  const commands = [];
  const plan = selection.testPlan;
  if (plan.fullTests) commands.push(pnpmCommand(['exec', 'vitest', 'run']));
  else if (plan.explicitSelectorTests?.length > 0) {
    commands.push(pnpmCommand(['exec', 'vitest', 'run', ...plan.explicitSelectorTests]));
  }
  if (!plan.fullTests && plan.mode === 'changed-fallback') {
    commands.push(pnpmCommand(['exec', 'vitest', 'run', `--changed=${selection.mergeBase}`, '--passWithNoTests']));
  } else if (!plan.fullTests && plan.relatedTestRelevantFiles?.length > 0) {
    commands.push(pnpmCommand(['exec', 'vitest', 'related', ...plan.relatedTestRelevantFiles, '--run', '--passWithNoTests']));
  }
  return commands;
}

function parseSelector(stdout) {
  const plan = extractJson(stdout);
  if (!plan || plan.report !== 'affected-verification-plan') {
    throw new Error('Selector did not return an affected-verification-plan JSON document.');
  }
  return plan;
}

function stageNamesFor(gate) {
  return stageOrder[gate].map((name) => plannedStage(name));
}

export async function runVerificationGate({
  gate,
  base = process.env.LITTLESHEEP_BASE_REF || 'origin/main',
  execute = defaultExecute,
  reportDirectory = defaultReportDirectory,
  output = null,
  keep = 5,
  list = false,
} = {}) {
  if (!gateNames.has(gate)) throw new Error(`Unsupported gate: ${gate}`);
  const startedAt = new Date();
  const timerStartedAt = performance.now();
  const stages = stageNamesFor(gate);
  let selection = null;
  let failedStage = null;
  const executeAndStop = async (name, spec, details = {}) => {
    const result = await runCommandStage(stages, name, spec, execute, details);
    if (result.status === 'failed') {
      failedStage = name;
      markBlocked(stages, result.index + 1, `blocked by failed stage ${name}`);
      return false;
    }
    return true;
  };

  if (!(await executeAndStop('check:repo', gateCommand('check:repo', base)))) {
    // The remaining stages are already marked blocked.
  } else if (gate === 'changed') {
    const selectorSpec = gateCommand('selector', base);
    const selectorRun = await runCommandStage(stages, 'selector', selectorSpec, execute);
    if (selectorRun.status === 'failed') {
      failedStage = 'selector';
      markBlocked(stages, selectorRun.index + 1, 'blocked by failed stage selector');
    } else {
      try {
        selection = parseSelector(selectorRun.result.stdout);
      } catch (error) {
        const selectorStage = stages.find((stage) => stage.name === 'selector');
        selectorStage.status = 'failed';
        selectorStage.reason = error instanceof Error ? error.message : String(error);
        failedStage = 'selector';
        markBlocked(stages, selectorRun.index + 1, 'blocked by failed stage selector');
      }
    }
    if (selection && !failedStage) {
      stages.find((stage) => stage.name === 'selector').details = {
        mergeBase: selection.mergeBase,
        changedFiles: selection.changedFiles,
        affectedPackages: selection.affectedPackages,
        testPlan: selection.testPlan,
        appBuildSensitiveFiles: selection.appBuildSensitiveFiles,
      };

      const env = { LITTLESHEEP_BASE_REF: base };
      if (selection.typecheckConfigPaths?.length > 0) {
        if (!(await executeAndStop('typecheck', { commands: [affectedTypecheckCommand(selection)], env }, {
          affectedPackages: selection.affectedPackages,
        }))) {
          markSkipped(stages, 'tests', 'blocked by failed stage typecheck');
          markSkipped(stages, 'build', 'blocked by failed stage typecheck');
        }
      } else {
        markSkipped(stages, 'typecheck', 'no affected package');
      }

      if (!failedStage) {
        if (selection.testPlan?.mode === 'skip') {
          markSkipped(stages, 'tests', 'no related source or test file', { testPlan: selection.testPlan });
        } else if (!(await executeAndStop('tests', { commands: affectedTestCommands(selection), env }, {
          testPlan: selection.testPlan,
        }))) {
          markSkipped(stages, 'build', 'blocked by failed stage tests');
        }
      }

      if (!failedStage) {
        if (selection.appBuildSensitive) {
          const buildResult = await runCommandStage(stages, 'build', { ...pnpmCommand(['run', 'ensure:app-build']), env }, execute, {
            appBuildSensitiveFiles: selection.appBuildSensitiveFiles,
          });
          const buildJson = extractJson(buildResult.result.stdout);
          if (buildJson) stages.find((stage) => stage.name === 'build').details.artifactStatus = buildJson.status ?? null;
          if (buildResult.status === 'failed') {
            failedStage = 'build';
            markBlocked(stages, buildResult.index + 1, 'blocked by failed stage build');
          }
        } else {
          markSkipped(stages, 'build', 'no App build-sensitive input');
        }
      }
    }
  } else if (gate === 'core') {
    markSkipped(stages, 'selector', 'not part of core gate');
    markSkipped(stages, 'build', 'not part of core gate');
    markSkipped(stages, 'recovery', 'not part of core gate');
    if (!failedStage && !(await executeAndStop('typecheck', gateCommand('core:typecheck', base)))) {
      markSkipped(stages, 'tests', 'blocked by failed stage typecheck');
    }
    if (!failedStage) await executeAndStop('tests', gateCommand('core:tests', base));
  } else {
    markSkipped(stages, 'selector', 'not part of full gate');
    if (!failedStage && !(await executeAndStop('tests', gateCommand('full:tests', base)))) {
      markSkipped(stages, 'typecheck', 'blocked by failed stage tests');
      markSkipped(stages, 'build', 'blocked by failed stage tests');
      markSkipped(stages, 'recovery', 'blocked by failed stage tests');
    }
    if (!failedStage && !(await executeAndStop('typecheck', gateCommand('full:typecheck', base)))) {
      markSkipped(stages, 'build', 'blocked by failed stage typecheck');
      markSkipped(stages, 'recovery', 'blocked by failed stage typecheck');
    }
    if (!failedStage && !(await executeAndStop('build', gateCommand('full:build', base)))) {
      markSkipped(stages, 'recovery', 'blocked by failed stage build');
    }
    if (!failedStage) await executeAndStop('recovery', gateCommand('recovery', base));
  }

  if (gate === 'changed') markSkipped(stages, 'recovery', 'not part of changed gate');
  const finishedAt = new Date();
  const report = {
    schemaVersion: 1,
    report: 'verification-gate',
    gate,
    status: failedStage ? 'failed' : 'passed',
    failedStage,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.round((performance.now() - timerStartedAt) * 100) / 100,
    base,
    mergeBase: selection?.mergeBase ?? null,
    selection,
    stages,
  };
  const persisted = await writeVerificationReport(report, { reportDirectory, output, keep });
  if (list) console.log(JSON.stringify(persisted, null, 2));
  else console.log(summarizeGateReport(persisted));
  return persisted;
}

function usage() {
  return [
    'Run a verification gate and persist a structured local report.',
    '',
    'Usage:',
    '  pnpm.cmd run verify:changed',
    '  pnpm.cmd run verify:core',
    '  pnpm.cmd run verify:full',
    '',
    'Options: --gate=changed|core|full --base=<ref> --report-dir=<path> --output=<path> --keep=<n> --list',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const report = await runVerificationGate(options);
    if (report.status === 'failed') process.exitCode = 1;
  } catch (error) {
    console.error(`[verification-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[verification-gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
