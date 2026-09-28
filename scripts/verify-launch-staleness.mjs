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
//      `build:app`), so the click never reached `scripts/launch-littlesheep.ps1`. Nothing asked
//      whether `packages/app/out` matched the sources, and the icon started whatever bytes were
//      lying there — a build that never happened left the previous UI on screen with no message
//      anywhere;
//   2. when the launcher *was* reached, `pnpm` is not on PATH on this machine, the build path
//      reported that as a generic `exit 1` behind an inherited stderr stream, and the launcher's
//      own failure was invisible from a shortcut (hidden window, no dialog): "the build never
//      ran" and "the build is current" read the same to the person who clicked.
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
    pid: result.pid,
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
    "@(Get-CimInstance Win32_Process -Filter \"Name='LittleSheep.exe'\" | Select-Object ProcessId, ParentProcessId) | ConvertTo-Json -Depth 3 -Compress",
  );
  const parsed = jsonFrom(result.stdout);
  if (parsed === null) return [];
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map((value) => ({ id: Number(value?.ProcessId), parentId: Number(value?.ParentProcessId) }))
    .filter((value) => Number.isFinite(value.id));
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

/**
 * What a launcher run did, and whether it started the app.
 *
 * Whether Electron started is judged by *attribution*, not by a process diff: this checkout is
 * shared, and another window appearing while the launcher runs says nothing about the launcher.
 * The launcher waits for the Electron it started, so a `LittleSheep.exe` whose parent is this
 * exact launcher process is one it started, and the launcher's own start line says the same
 * thing in the output.
 */
function inspectLauncherRun(label, { env, expectedPnpmName = null }) {
  const before = runningAppProcessIds();
  // A launcher that (wrongly) starts the app waits for it to exit, so a failed assertion must not
  // turn into an open-ended hang; the run is cut off and reported as such.
  const result = run('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherPath, '-NoDialog'], {
    env,
    timeoutMs: 240_000,
  });
  const after = runningAppProcessIds();
  const attributed = after.filter((process) => process.parentId === result.pid);
  const output = result.output;
  const tail = output.length > 4_000 ? output.slice(-4_000) : output;
  const startedLine = /Starting LittleSheep from/u.test(output);

  check(
    `${label}: the launcher refuses instead of starting the previous build`,
    result.status !== 0,
    `exit=${result.status ?? 'null'}${result.signal ? ` signal=${result.signal}` : ''}`,
  );
  check(
    `${label}: the launcher started no Electron process`,
    attributed.length === 0 && !startedLine,
    attributed.length > 0
      ? `LittleSheep.exe children of the launcher (pid ${result.pid}): ${attributed.map((process) => process.id).join(', ')}`
      : 'no child LittleSheep.exe, no start line',
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
  return { result, started: attributed, output: tail, startedLine, observedProcesses: after.length - before.length };
}

/**
 * Run one fail-closed case, retrying when *another* process (a concurrent `ensure:app-build`, a
 * dev server, another agent in the same checkout) rebuilds the App between the invalidation and
 * the launcher run. That does not weaken the assertion — it restores the premise the assertion
 * needs, namely a build the launcher cannot prove current.
 */
function runFailClosedCase({ label, env, expectedPnpmName, maxAttempts = 3 }) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const invalidated = node([ensureScript, '--invalidate']);
    if (invalidated.status !== 0) {
      check(`${label}: the App fingerprint can be invalidated for the run`, false, invalidated.output.trim());
      return last;
    }
    const stale = node([ensureScript, '--assert']);
    if (stale.status === 0) {
      notes.push(`${label}: the build was still current after invalidation; retrying.`);
      continue;
    }
    if (attempt === 1) check('B1: an invalidated fingerprint reads as not current', true, `exit=${stale.status ?? 'null'}`);
    last = { ...inspectLauncherRun(label, { env, expectedPnpmName }), attempt, invalidatedAt: new Date().toISOString() };
    if (last.result.status !== 0 && !last.startedLine) return last;
    notes.push(
      `${label}: attempt ${attempt} started the app instead of refusing — something rebuilt `
      + 'packages/app/out while the gate was running; retrying with a fresh invalidation.',
    );
  }
  if (last === null) {
    // Never let "the premise could not be established" read as a pass.
    check(
      `${label}: the build could not be made unprovable for this run`,
      false,
      `another process rebuilt packages/app/out after every one of ${maxAttempts} invalidations`,
    );
  }
  return last;
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
      'Whether Electron started is attributed by parent process: a LittleSheep.exe started by another process while the gate runs is not counted, and every fail-closed case is retried when something else rebuilds packages/app/out mid-run.',
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

    // ---- B. a build that fails -------------------------------------------------------------
    const failing = runFailClosedCase({
      label: 'B2',
      env: { LITTLESHEEP_PNPM: stubPnpm },
      expectedPnpmName: 'pnpm-fail-stub',
    });
    report.failingBuild = failing
      ? {
        exitCode: failing.result.status,
        attempts: failing.attempt,
        childProcessIds: failing.started.map((process) => process.id),
        output: failing.output,
      }
      : null;

    // ---- C. a package manager that cannot be resolved ---------------------------------------
    const missing = join(stubDirectory, 'pnpm-that-does-not-exist.cmd');
    rmSync(missing, { force: true });
    const unresolved = runFailClosedCase({
      label: 'C1',
      env: { LITTLESHEEP_PNPM: missing },
      expectedPnpmName: 'pnpm-that-does-not-exist',
    });
    report.missingPnpm = unresolved
      ? {
        exitCode: unresolved.result.status,
        attempts: unresolved.attempt,
        childProcessIds: unresolved.started.map((process) => process.id),
        output: unresolved.output,
      }
      : null;
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
