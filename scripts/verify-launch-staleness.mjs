#!/usr/bin/env node
//
// The launch path must never start a bundle it cannot prove current.
//
// Two defects met in the same symptom — "I changed the UI, restarted the app, and nothing
// changed":
//
//   1. the desktop shortcut pointed straight at
//      `packages/app/runtime/electron-v<version>-win32-x64/LittleSheep.exe`
//      (`scripts/refresh-desktop-shortcut.ps1`, refreshed on every `predev` / `prebuild` /
//      `build:app`), so the click never reached `scripts/launch-littlesheep.ps1` and nothing
//      ever asked whether `packages/app/out` matched the sources;
//   2. when the launcher *was* reached and the build could not run — `pnpm` is not on PATH on
//      this machine, and the build used to fail behind an inherited stderr stream plus a generic
//      exit code — the previous bundle was still there to be started, and nothing said otherwise.
//
// This gate exercises both halves against the real artifacts, not a fixture:
//
//   A. click path     — the installed `.lnk` files must target the launcher, not the runtime
//                       executable (repaired through the launcher's own `-ShortcutsOnly` when a
//                       link exists but points elsewhere);
//   B. failing build  — with the App fingerprint invalidated and `pnpm` replaced by a stub that
//                       exits 7, the launcher must refuse, name the failure, name the
//                       `-AllowStaleBuild` opt-in, and start no Electron process;
//   C. missing pnpm   — with the same invalidation and `pnpm` impossible to resolve, the launcher
//                       must refuse and say which executable it could not find;
//   D. state          — the App fingerprint is restored byte-exactly (unless a build genuinely
//                       rewrote `packages/app/out` during the run, in which case the newer,
//                       self-consistent fingerprint is kept), and a build that was current
//                       before the gate is still current after it.
//
// Nothing here writes inside the checkout: the stub package manager and the report live in the
// shared run-artifacts root (`scripts/lib/run-artifacts.mjs`), and the only file touched is the
// generated `packages/app/out/.littlesheep-build-fingerprint.json` sidecar, which is invalidated
// and then put back.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runArtifact } from './lib/run-artifacts.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = join(repoRoot, 'scripts', 'launch-littlesheep.ps1');
const ensureScript = join(repoRoot, 'scripts', 'ensure-app-build.mjs');
const outDirectory = join(repoRoot, 'packages', 'app', 'out');
const sidecarPath = join(outDirectory, '.littlesheep-build-fingerprint.json');
const launcherRelative = join('scripts', 'launch-littlesheep.ps1');

const assertions = [];
const notes = [];

function check(label, condition, detail = '') {
  assertions.push({ label, ok: Boolean(condition), detail });
  return Boolean(condition);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeoutMs ?? 10 * 60_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function node(args, options) {
  return run(process.execPath, args, options);
}

function powershell(script, options = {}) {
  return run('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], options);
}

function psQuote(value) {
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function jsonFrom(text) {
  const source = String(text ?? '').trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    const line = source.split(/\r?\n/u).filter((value) => value.trim().startsWith('{') || value.trim().startsWith('[')).at(-1);
    if (!line) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
}

/** The real shortcut files, read through the same COM path Explorer uses. */
function readShortcuts(paths) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$shell = New-Object -ComObject WScript.Shell',
    '$result = @()',
    `foreach ($path in @(${paths.map(psQuote).join(', ')})) {`,
    '  if (Test-Path -LiteralPath $path -PathType Leaf) {',
    '    $link = $shell.CreateShortcut($path)',
    '    $result += [pscustomobject]@{ path = $path; exists = $true; target = [string]$link.TargetPath; arguments = [string]$link.Arguments; workingDirectory = [string]$link.WorkingDirectory; icon = [string]$link.IconLocation }',
    '  } else {',
    '    $result += [pscustomobject]@{ path = $path; exists = $false; target = $null; arguments = $null; workingDirectory = $null; icon = $null }',
    '  }',
    '}',
    '@($result) | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');
  const result = powershell(script);
  if (result.status !== 0) {
    return { ok: false, detail: result.output.trim(), links: [] };
  }
  const parsed = jsonFrom(result.stdout);
  const links = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return { ok: true, detail: '', links };
}

function shortcutPaths() {
  const script = [
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    "$programs = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'",
    '@(',
    "  (Join-Path $desktop 'LittleSheep.lnk'),",
    "  (Join-Path $programs 'LittleSheep.lnk')",
    ') | ConvertTo-Json -Compress',
  ].join('\n');
  const result = powershell(script);
  const parsed = jsonFrom(result.stdout);
  return Array.isArray(parsed) ? parsed : [];
}

function runningAppProcessIds() {
  const result = powershell(
    "@(Get-Process -Name 'LittleSheep' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress",
  );
  const parsed = jsonFrom(result.stdout);
  if (parsed === null) return [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((value) => Number(value)).filter(Number.isFinite);
}

function newestMtimeMs(directory) {
  let newest = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      try {
        const stats = statSync(path);
        if (stats.mtimeMs > newest) newest = stats.mtimeMs;
      } catch {
        // A file that disappeared mid-walk cannot make the directory look newer.
      }
    }
  };
  walk(directory);
  return newest;
}

/** What a launcher run did, and whether it started the app. */
function inspectLauncherRun(label, { env, expectedPnpmName = null }) {
  const before = runningAppProcessIds();
  // A launcher that (wrongly) starts the app waits for it to exit, so a failed assertion must not
  // turn into an open-ended hang; the run is cut off and reported as such.
  const result = run('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherPath, '-NoDialog'], {
    env,
    timeoutMs: 240_000,
  });
  const after = runningAppProcessIds();
  const started = after.filter((id) => !before.includes(id));
  const output = result.output;
  const tail = output.length > 4_000 ? output.slice(-4_000) : output;

  check(
    `${label}: the launcher refuses instead of starting the previous build`,
    result.status !== 0,
    `exit=${result.status ?? 'null'}${result.signal ? ` signal=${result.signal}` : ''}`,
  );
  check(
    `${label}: no Electron process was started`,
    started.length === 0 && !/Starting LittleSheep from/u.test(output),
    started.length > 0 ? `new LittleSheep pids: ${started.join(', ')}` : 'no new LittleSheep process, no start line',
  );
  check(
    `${label}: the reason is visible in the output`,
    /\[app-build\]|pnpm|simulated-build-failure/u.test(output),
    output.trim().split(/\r?\n/u).slice(-4).join(' | '),
  );
  check(
    `${label}: the refusal names the -AllowStaleBuild opt-in`,
    /-AllowStaleBuild/u.test(output),
    '',
  );
  if (expectedPnpmName) {
    check(
      `${label}: the message names ${expectedPnpmName}`,
      output.includes(expectedPnpmName),
      '',
    );
  }
  return { result, started, output: tail };
}

function runGate() {
  const report = {
    schemaVersion: 1,
    report: 'launch-staleness-gate',
    startedAt: new Date().toISOString(),
    repoRoot,
    launcher: launcherPath,
    shortcuts: null,
    failingBuild: null,
    missingPnpm: null,
    fingerprint: null,
    assertions,
    notes,
    limits: [
      'The gate simulates the two failure conditions (a build command that fails, and a package manager that cannot be resolved); it does not corrupt the real toolchain.',
      'The healthy path — the launcher builds, verifies and starts the window — needs a real Electron window and is deliberately not started here. It is exercised by launching the app itself.',
      'The click path is asserted on the .lnk files Explorer reads; the gate does not simulate a mouse click on the icon.',
    ],
  };

  // ---- A. the click path -------------------------------------------------------------------
  const paths = shortcutPaths();
  const initial = readShortcuts(paths);
  if (!check('A1: the installed shortcuts can be read', initial.ok && initial.links.length > 0, initial.detail)) {
    report.shortcuts = initial;
    return report;
  }
  const installed = initial.links.filter((link) => link.exists);
  if (installed.length === 0) {
    notes.push('No LittleSheep shortcut is installed on this desktop; the click-path assertion is skipped.');
  } else {
    const launcherTarget = (link) => typeof link.target === 'string'
      && /(?:^|[\\/])pwsh\.exe$|(?:^|[\\/])powershell\.exe$/iu.test(link.target)
      && typeof link.arguments === 'string'
      && link.arguments.includes(launcherRelative);
    const mispointed = installed.filter((link) => !launcherTarget(link));
    let repaired = false;
    if (mispointed.length > 0) {
      // An installed icon that bypasses the launcher is the defect itself: repair it through the
      // launcher's own -ShortcutsOnly entry, then judge the result.
      const repair = run('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherPath, '-ShortcutsOnly']);
      repaired = repair.status === 0;
      notes.push(`Repaired ${mispointed.length} shortcut(s) that bypassed the launcher (exit ${repair.status ?? 'null'}).`);
    }
    const final = readShortcuts(paths).links.filter((link) => link.exists);
    report.shortcuts = { paths, initial: installed, final, repaired };
    for (const link of final) {
      check(
        `A2: ${link.path} starts the launcher, not the runtime executable`,
        launcherTarget(link),
        `target=${link.target ?? ''} arguments=${link.arguments ?? ''}`,
      );
    }
  }

  // ---- D. the state this gate starts from --------------------------------------------------
  const hadSidecar = existsSync(sidecarPath);
  const backup = hadSidecar ? readFileSync(sidecarPath) : null;
  const outputsBefore = newestMtimeMs(outDirectory);
  const freshnessBefore = node([ensureScript, '--assert']).status === 0;
  report.fingerprint = { hadSidecar, freshnessBefore, outputsBefore };

  const stubDirectory = runArtifact('launch-staleness');
  mkdirSync(stubDirectory, { recursive: true });
  const stubPnpm = join(stubDirectory, process.platform === 'win32' ? 'pnpm-fail-stub.cmd' : 'pnpm-fail-stub');
  writeFileSync(
    stubPnpm,
    process.platform === 'win32'
      ? '@echo off\r\necho simulated-build-failure: this build is forced to fail by the launch-staleness gate 1>&2\r\nexit /b 7\r\n'
      : '#!/bin/sh\necho "simulated-build-failure: this build is forced to fail by the launch-staleness gate" 1>&2\nexit 7\n',
    'utf8',
  );

  try {
    // The launcher can only refuse a build it *cannot prove current*; removing the sidecar is
    // exactly that state, and it is restored below.
    const invalidated = node([ensureScript, '--invalidate']);
    check('B0: the App fingerprint can be invalidated for the run', invalidated.status === 0, invalidated.output.trim());
    const stale = node([ensureScript, '--assert']);
    check('B1: an invalidated fingerprint reads as not current', stale.status !== 0, `exit=${stale.status ?? 'null'}`);

    // ---- B. a build that fails -------------------------------------------------------------
    const failing = inspectLauncherRun('B2', {
      env: { LITTLESHEEP_PNPM: stubPnpm },
      expectedPnpmName: 'pnpm-fail-stub',
    });
    report.failingBuild = {
      exitCode: failing.result.status,
      startedProcessIds: failing.started,
      output: failing.output,
    };

    // ---- C. a package manager that cannot be resolved ---------------------------------------
    const missing = join(stubDirectory, 'pnpm-that-does-not-exist.cmd');
    rmSync(missing, { force: true });
    const unresolved = inspectLauncherRun('C1', {
      env: { LITTLESHEEP_PNPM: missing },
      expectedPnpmName: 'pnpm-that-does-not-exist',
    });
    report.missingPnpm = {
      exitCode: unresolved.result.status,
      startedProcessIds: unresolved.started,
      output: unresolved.output,
    };
  } finally {
    const outputsAfter = newestMtimeMs(outDirectory);
    const rebuilt = outputsAfter > outputsBefore;
    if (!rebuilt) {
      if (hadSidecar) writeFileSync(sidecarPath, backup);
      else rmSync(sidecarPath, { force: true });
      notes.push('The App fingerprint sidecar was restored byte-exactly; no build rewrote packages/app/out during the run.');
    } else {
      notes.push('A build rewrote packages/app/out during the run, so the fingerprint it recorded was kept instead of the previous sidecar.');
    }
    report.fingerprint = { ...report.fingerprint, outputsAfter, rebuilt };
  }

  const freshnessAfter = node([ensureScript, '--assert']).status === 0;
  report.fingerprint.freshnessAfter = freshnessAfter;
  check(
    'D1: the gate left the build as current as it found it',
    !freshnessBefore || freshnessAfter,
    `before=${freshnessBefore} after=${freshnessAfter}`,
  );

  return report;
}

function finish(report) {
  const failed = report.assertions.filter((entry) => !entry.ok);
  report.finishedAt = new Date().toISOString();
  report.status = failed.length === 0 ? 'passed' : 'failed';
  report.failedAssertions = failed.map((entry) => entry.label);
  const directory = runArtifact('launch-staleness');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'report.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  report.reportPath = path;

  for (const entry of report.assertions) {
    console.log(`[${entry.ok ? 'pass' : 'fail'}] ${entry.label}${entry.detail ? `: ${entry.detail}` : ''}`);
  }
  for (const note of report.notes) console.log(`[note] ${note}`);
  console.log(`\nLaunch staleness gate: ${report.status} (${report.assertions.filter((entry) => entry.ok).length} passed, ${failed.length} failed)`);
  console.log(`Report: ${path}`);
  if (failed.length > 0) process.exitCode = 1;
  return report;
}

function main() {
  let report;
  try {
    report = runGate();
  } catch (error) {
    // A gate must fail with a named check, never by disappearing: a working tree mid-change is
    // exactly when someone runs it.
    check('the gate itself completed', false, error instanceof Error ? error.message : String(error));
    report = {
      schemaVersion: 1,
      report: 'launch-staleness-gate',
      startedAt: new Date().toISOString(),
      assertions,
      notes,
      limits: [],
    };
  }
  if (!report.finishedAt) finish(report);
}

main();
