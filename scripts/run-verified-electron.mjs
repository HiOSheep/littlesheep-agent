import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAppBuildFresh } from './lib/app-build-fingerprint.mjs';
import { assertCanonicalPathInside } from './lib/build-fingerprint.mjs';
import { resolveVerifiedElectronExecutable } from './lib/electron-runtime.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = resolve(repoRoot, 'packages', 'app');
const [scriptArg, ...scriptArgs] = process.argv.slice(2);

if (!scriptArg || scriptArg.startsWith('-')) {
  console.error('Usage: node scripts/run-verified-electron.mjs <script> [args...]');
  process.exit(2);
}

await assertAppBuildFresh(repoRoot);
const executable = resolveVerifiedElectronExecutable(repoRoot, { requireAppBuildManifest: true });
const scriptPath = resolve(repoRoot, scriptArg);
await assertCanonicalPathInside(repoRoot, scriptPath, {
  rejectSymlink: true,
  label: 'verified Electron script',
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(executable, [scriptPath, ...scriptArgs], {
  cwd: appRoot,
  env,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(`Verified Electron launcher failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Verified Electron launcher exited by signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
