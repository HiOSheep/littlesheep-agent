import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const supportedArgs = new Set(['--dir', '--installer']);
const unexpected = [...args].filter((arg) => !supportedArgs.has(arg));

if (unexpected.length > 0 || args.size !== 1) {
  throw new Error('Use exactly one of --dir or --installer.');
}

const mode = args.has('--dir') ? 'dir' : 'installer';
const configPath = resolve(repoRoot, 'packages', 'app', 'electron-builder.yml');
const appRoot = resolve(repoRoot, 'packages', 'app');
const appRequire = createRequire(resolve(appRoot, 'package.json'));
const outputRoot = resolve(repoRoot, 'release');
const releaseLockRoot = resolve(appRoot, '.release-packaging-lock');

if (!existsSync(configPath)) throw new Error(`Release configuration is missing: ${configPath}`);

let releaseStagingRoot;
let temporaryConfigPath;
let lockAcquired = false;
try {
  try {
    await mkdir(releaseLockRoot);
    lockAcquired = true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error('Another Windows release packaging process is already running.');
    }
    throw error;
  }

  if (process.platform === 'win32') {
    await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd run ensure:app-build']);
  } else {
    await run('pnpm', ['run', 'ensure:app-build']);
  }

  releaseStagingRoot = await mkdtemp(resolve(appRoot, '.release-staging-'));
  const releaseStagingOut = resolve(releaseStagingRoot, 'out');
  const releaseStagingElectron = resolve(releaseStagingRoot, 'electron');
  temporaryConfigPath = resolve(appRoot, `.electron-builder-${process.pid}-${Date.now()}.yml`);
  const config = await readFile(configPath, 'utf8');
  const stagingReference = relative(appRoot, releaseStagingOut).replaceAll('\\', '/');
  const electronReference = relative(appRoot, releaseStagingElectron).replaceAll('\\', '/');
  const configured = config
    .replace('from: .release-staging/out', `from: ${stagingReference}`)
    .replace('productName: LittleSheep', `productName: LittleSheep\nelectronDist: ${electronReference}`);
  if (configured === config) throw new Error('Release configuration does not contain the staging input path.');
  await writeFile(temporaryConfigPath, configured, 'utf8');
  await cp(resolve(appRoot, 'out'), releaseStagingOut, { recursive: true, force: false, errorOnExist: true });
  const electronExecutable = resolve(String(appRequire('electron')).trim());
  await cp(dirname(electronExecutable), releaseStagingElectron, { recursive: true, force: false, errorOnExist: true });
  await run(process.execPath, [
    resolve(repoRoot, 'node_modules', 'electron-builder', 'cli.js'),
    '--project', appRoot,
    '--config', temporaryConfigPath,
    '--win',
    '--x64',
    ...(mode === 'dir' ? ['--dir'] : []),
  ]);
} finally {
  if (temporaryConfigPath) await rm(temporaryConfigPath, { force: true });
  if (releaseStagingRoot) await rm(releaseStagingRoot, { recursive: true, force: true });
  if (lockAcquired) await rm(releaseLockRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  check: 'windows-release-package',
  status: 'passed',
  ok: true,
  mode,
  outputRoot,
  signed: false,
  note: 'The generated package is unsigned. Signing and clean-machine installation remain release gates.',
}));

function run(command, commandArgs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      shell: options.shell ?? false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`Command failed (${signal ?? `exit ${code ?? 'unknown'}`}): ${command}`));
    });
  });
}
