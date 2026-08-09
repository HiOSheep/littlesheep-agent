import { spawnSync } from 'node:child_process';
import { access, lstat, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWorkspaceProjects } from '../workspace-projects.mjs';
import {
  assertCanonicalPathInside,
  atomicWriteJson,
  digestContract,
  fingerprintPaths,
  normalizeFingerprintPath,
} from './build-fingerprint.mjs';
import {
  electronRuntimeContract,
  fingerprintPreparedElectronRuntime,
} from './electron-runtime.mjs';
import { ensureWorkspaceArtifacts } from './workspace-artifact-fingerprint.mjs';

export const APP_BUILD_MANIFEST_VERSION = 1;
export const APP_BUILD_MANIFEST_NAME = '.littlesheep-build-fingerprint.json';
export const APP_BUILD_REQUIRED_OUTPUTS = Object.freeze([
  'packages/app/out/main/index.js',
  'packages/app/out/preload/index.js',
  'packages/app/out/renderer/index.html',
]);

const ROOT_BUILD_INPUTS = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.workspace.json',
  'scripts/prepare-littlesheep-runtime.mjs',
  'scripts/workspace-projects.mjs',
  'scripts/ensure-app-build.mjs',
  'scripts/ensure-workspace-artifacts.mjs',
  'scripts/run-verified-electron.mjs',
  'scripts/lib/build-fingerprint.mjs',
  'scripts/lib/electron-runtime.mjs',
  'scripts/lib/app-build-fingerprint.mjs',
  'scripts/lib/workspace-artifact-fingerprint.mjs',
]);

const REQUIRED_APP_OUTPUTS = APP_BUILD_REQUIRED_OUTPUTS;

const WORKSPACE_DEPENDENCY_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

const GENERATED_SEGMENTS = new Set(['node_modules', 'dist', 'out', 'coverage', '.git']);

function repoRelative(repoRoot, path) {
  return normalizeFingerprintPath(relative(repoRoot, path));
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function shouldIncludeBuildInput(path, isDirectory) {
  const segments = normalizeFingerprintPath(path).split('/');
  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) return false;
  if (!isDirectory && path.endsWith(APP_BUILD_MANIFEST_NAME)) return false;
  return true;
}

function shouldIncludeBuildOutput(path, isDirectory) {
  const normalized = normalizeFingerprintPath(path);
  if (!isDirectory && normalized.endsWith(`/${APP_BUILD_MANIFEST_NAME}`)) return false;
  if (!isDirectory && /\/\.[^.]+\.tmp$/.test(normalized)) return false;
  return true;
}

async function readManifest(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read workspace package manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error(`Workspace package manifest has no valid name: ${path}`);
  }
  return value;
}

async function workspaceDependencyClosure(repoRoot) {
  const projects = await discoverWorkspaceProjects(repoRoot);
  const byName = new Map(projects.map((project) => [project.name, project]));
  const app = byName.get('@littlesheep/app');
  if (!app) throw new Error('Workspace project @littlesheep/app was not discovered.');

  const manifests = new Map();
  for (const project of projects) {
    manifests.set(project.name, await readManifest(join(project.directory, 'package.json')));
  }

  const closure = new Set();
  const queue = [app.name];
  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    closure.add(name);
    const manifest = manifests.get(name);
    if (!manifest) throw new Error(`Workspace package manifest is unavailable for ${name}.`);
    for (const section of WORKSPACE_DEPENDENCY_SECTIONS) {
      const dependencies = manifest[section];
      if (dependencies !== undefined && (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))) {
        throw new Error(`Workspace package ${name} has invalid ${section}.`);
      }
      for (const [dependency, version] of Object.entries(dependencies ?? {})) {
        if (typeof version !== 'string') {
          throw new Error(`Workspace package ${name} has non-string ${section} value for ${dependency}.`);
        }
        if (!version.startsWith('workspace:')) continue;
        if (!byName.has(dependency)) {
          throw new Error(`Workspace package ${name} references missing workspace dependency ${dependency}.`);
        }
        queue.push(dependency);
      }
    }
  }
  return [...closure].map((name) => byName.get(name)).sort((left, right) => left.name.localeCompare(right.name));
}

async function projectInputPaths(repoRoot, project) {
  const paths = [`${project.relativeDirectory}/package.json`];
  for (const config of project.tsconfigs) paths.push(`${project.relativeDirectory}/${config}`);
  for (const directory of ['src', 'resources']) {
    const path = join(project.directory, directory);
    if (await exists(path)) paths.push(repoRelative(repoRoot, path));
  }
  const rootEntries = [
    'electron.vite.config.ts',
    'electron.vite.config.mts',
    'vite.config.ts',
    'vite.config.mts',
  ];
  for (const entry of rootEntries) {
    const path = join(project.directory, entry);
    if (await exists(path)) paths.push(repoRelative(repoRoot, path));
  }
  return paths;
}

export function appBuildManifestPath(repoRoot) {
  return resolve(repoRoot, 'packages/app/out', APP_BUILD_MANIFEST_NAME);
}

export async function collectAppBuildInputs(repoRoot, runtimeIdentity) {
  const projects = await workspaceDependencyClosure(repoRoot);
  const inputPaths = [...ROOT_BUILD_INPUTS];
  for (const project of projects) inputPaths.push(...await projectInputPaths(repoRoot, project));
  const source = await fingerprintPaths(repoRoot, inputPaths, {
    shouldInclude: shouldIncludeBuildInput,
  });
  const runtime = electronRuntimeContract(runtimeIdentity);
  return {
    digest: digestContract({ sourceDigest: source.digest, runtime }),
    sourceDigest: source.digest,
    fileCount: source.fileCount,
    totalBytes: source.totalBytes,
    workspacePackages: projects.map((project) => project.name),
    runtime,
  };
}

export async function fingerprintAppBuildOutputs(repoRoot) {
  const outRoot = resolve(repoRoot, 'packages/app/out');
  const outInfo = await lstat(outRoot);
  if (outInfo.isSymbolicLink() || !outInfo.isDirectory()) {
    throw new Error(`App output directory is not a regular directory: ${outRoot}`);
  }
  await assertCanonicalPathInside(repoRoot, outRoot, {
    rejectSymlink: true,
    label: 'App output directory',
  });
  for (const requiredPath of REQUIRED_APP_OUTPUTS) {
    const absolutePath = resolve(repoRoot, requiredPath);
    try {
      await assertCanonicalPathInside(outRoot, absolutePath, {
        rejectSymlink: true,
        label: `required App output ${requiredPath}`,
      });
      const info = await lstat(absolutePath);
      if (!info.isFile()) throw new Error(`Required App output is not a file: ${requiredPath}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes(requiredPath)) throw error;
      throw new Error(
        `Required App output is unavailable: ${requiredPath}. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const fingerprint = await fingerprintPaths(repoRoot, ['packages/app/out'], {
    shouldInclude: shouldIncludeBuildOutput,
  });
  return {
    digest: fingerprint.digest,
    fileCount: fingerprint.fileCount,
    totalBytes: fingerprint.totalBytes,
    requiredFiles: [...REQUIRED_APP_OUTPUTS],
  };
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('App build fingerprint manifest is not an object.');
  }
  if (manifest.schemaVersion !== APP_BUILD_MANIFEST_VERSION || manifest.kind !== 'littlesheep-app-build') {
    throw new Error(`Unsupported App build fingerprint manifest schema: ${manifest.schemaVersion ?? 'missing'}.`);
  }
  for (const field of ['input', 'runtime', 'output']) {
    if (!manifest[field] || typeof manifest[field] !== 'object' || Array.isArray(manifest[field])) {
      throw new Error(`App build fingerprint manifest has no valid ${field} contract.`);
    }
  }
  if (typeof manifest.input.digest !== 'string' || typeof manifest.output.digest !== 'string') {
    throw new Error('App build fingerprint manifest has no valid digest.');
  }
  return manifest;
}

export async function readAppBuildManifest(repoRoot) {
  const path = appBuildManifestPath(repoRoot);
  const outRoot = dirname(path);
  const outInfo = await lstat(outRoot).catch((error) => {
    if (error?.code === 'ENOENT') throw error;
    throw error;
  });
  if (outInfo.isSymbolicLink() || !outInfo.isDirectory()) {
    throw new Error(`App output directory is not a regular directory: ${outRoot}`);
  }
  await assertCanonicalPathInside(repoRoot, dirname(path), {
    allowRoot: true,
    rejectSymlink: true,
    label: 'App build fingerprint directory',
  });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`App build fingerprint manifest is not a regular file: ${path}`);
  }
  return validateManifestShape(JSON.parse(await readFile(path, 'utf8')));
}

export async function inspectAppBuildFreshness(repoRoot, {
  runtimeIdentity,
  resolveRuntime = fingerprintPreparedElectronRuntime,
} = {}) {
  let manifest;
  try {
    manifest = await readAppBuildManifest(repoRoot);
  } catch (error) {
    return { fresh: false, reason: 'manifest-unavailable', detail: error instanceof Error ? error.message : String(error) };
  }

  let currentRuntime = runtimeIdentity;
  try {
    currentRuntime ??= await resolveRuntime(repoRoot, manifest.runtime.preparedExecutable?.path);
  } catch (error) {
    return { fresh: false, reason: 'runtime-mismatch', detail: error instanceof Error ? error.message : String(error) };
  }
  if (digestContract(electronRuntimeContract(currentRuntime)) !== digestContract(manifest.runtime)) {
    return { fresh: false, reason: 'runtime-mismatch', manifest, runtime: currentRuntime };
  }

  let input;
  try {
    input = await collectAppBuildInputs(repoRoot, currentRuntime);
  } catch (error) {
    return { fresh: false, reason: 'input-unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
  if (input.digest !== manifest.input.digest) {
    return { fresh: false, reason: 'input-mismatch', manifest, input };
  }

  let output;
  try {
    output = await fingerprintAppBuildOutputs(repoRoot);
  } catch (error) {
    return { fresh: false, reason: 'output-unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
  if (output.digest !== manifest.output.digest) {
    return { fresh: false, reason: 'output-mismatch', manifest, input, output };
  }
  return { fresh: true, reason: 'match', manifest, input, output, runtime: currentRuntime };
}

export async function assertAppBuildFresh(repoRoot, options = {}) {
  const result = await inspectAppBuildFreshness(repoRoot, options);
  if (!result.fresh) {
    throw new Error(`App build artifacts are stale (${result.reason})${result.detail ? `: ${result.detail}` : '.'}`);
  }
  return result;
}

export async function invalidateAppBuildManifest(repoRoot) {
  const path = appBuildManifestPath(repoRoot);
  const outRoot = dirname(path);
  try {
    const outInfo = await lstat(outRoot);
    if (outInfo.isSymbolicLink() || !outInfo.isDirectory()) {
      throw new Error(`App output directory is not a regular directory: ${outRoot}`);
    }
    await assertCanonicalPathInside(repoRoot, outRoot, {
      allowRoot: true,
      rejectSymlink: true,
      label: 'App output directory',
    });
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`App build fingerprint manifest is a symbolic link: ${path}`);
    await rm(path, { force: true });
  } catch (error) {
    if (!(error instanceof Error) || error.code !== 'ENOENT') throw error;
  }
}

export async function writeAppBuildManifest(repoRoot, { input, output, runtime, mode }) {
  await invalidateAppBuildManifest(repoRoot);
  const manifest = {
    schemaVersion: APP_BUILD_MANIFEST_VERSION,
    kind: 'littlesheep-app-build',
    createdAt: new Date().toISOString(),
    mode,
    input,
    runtime: electronRuntimeContract(runtime),
    output,
  };
  await atomicWriteJson(appBuildManifestPath(repoRoot), manifest, {
    boundaryRoot: resolve(repoRoot, 'packages/app/out'),
  });
  return manifest;
}

async function defaultPrepareRuntime(repoRoot) {
  const script = resolve(repoRoot, 'scripts/prepare-littlesheep-runtime.mjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Electron runtime preparation failed with exit ${result.status ?? 'unknown'}: ${result.stderr?.trim() ?? ''}`);
  }
  const lines = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const runtimePath = lines.at(-1);
  if (!runtimePath) throw new Error('Electron runtime preparation did not report a runtime path.');
  return runtimePath;
}

function defaultBuild(repoRoot) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = ['--filter', '@littlesheep/app', 'run', 'build'];
  const invocation = process.platform === 'win32' && pnpm.toLowerCase().endsWith('.cmd')
    ? {
      command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', pnpm, ...args],
    }
    : { command: pnpm, args };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`App build failed with exit ${result.status ?? 'unknown'}.`);
}

async function ensureWorkspaceBuildClosure(repoRoot) {
  const projects = await workspaceDependencyClosure(repoRoot);
  const targetNames = projects
    .filter((project) => project.name !== '@littlesheep/app')
    .map((project) => project.name);
  if (targetNames.length === 0) return { status: 'not-needed', targetNames };
  return ensureWorkspaceArtifacts({ repoRoot, targetNames });
}

async function prepareIdentity(repoRoot, prepareRuntime, resolveRuntime) {
  const path = await prepareRuntime(repoRoot);
  return resolveRuntime(repoRoot, path);
}

export async function recordAppBuildManifest(repoRoot, {
  runtimeIdentity,
  prepareRuntime = defaultPrepareRuntime,
  resolveRuntime = fingerprintPreparedElectronRuntime,
  expectedInputDigest,
  mode = 'record',
} = {}) {
  await invalidateAppBuildManifest(repoRoot);
  const runtime = runtimeIdentity ?? await prepareIdentity(repoRoot, prepareRuntime, resolveRuntime);
  const input = await collectAppBuildInputs(repoRoot, runtime);
  if (expectedInputDigest && input.digest !== expectedInputDigest) {
    throw new Error('App build inputs changed before the build fingerprint could be recorded.');
  }
  const output = await fingerprintAppBuildOutputs(repoRoot);
  const manifest = await writeAppBuildManifest(repoRoot, { input, output, runtime, mode });
  return { manifest, input, output, runtime };
}

export async function ensureAppBuild(repoRoot, {
  force = false,
  prepareRuntime = defaultPrepareRuntime,
  resolveRuntime = fingerprintPreparedElectronRuntime,
  build = defaultBuild,
  ensureWorkspaceBuild = ensureWorkspaceBuildClosure,
} = {}) {
  await ensureWorkspaceBuild(repoRoot);
  const beforeRuntime = await prepareIdentity(repoRoot, prepareRuntime, resolveRuntime);
  const beforeInput = await collectAppBuildInputs(repoRoot, beforeRuntime);
  if (!force) {
    const inspection = await inspectAppBuildFreshness(repoRoot, {
      runtimeIdentity: beforeRuntime,
      resolveRuntime,
    });
    if (inspection.fresh) return { status: 'reused', ...inspection };
  }

  await invalidateAppBuildManifest(repoRoot);
  try {
    await build(repoRoot);
  } catch (error) {
    await invalidateAppBuildManifest(repoRoot);
    throw error;
  }

  const afterRuntime = await prepareIdentity(repoRoot, prepareRuntime, resolveRuntime);
  const afterInput = await collectAppBuildInputs(repoRoot, afterRuntime);
  if (beforeInput.digest !== afterInput.digest) {
    await invalidateAppBuildManifest(repoRoot);
    throw new Error('App build inputs changed while the build was running; refusing to record stale artifacts.');
  }
  const output = await fingerprintAppBuildOutputs(repoRoot).catch(async (error) => {
    await invalidateAppBuildManifest(repoRoot);
    throw error;
  });
  const manifest = await writeAppBuildManifest(repoRoot, {
    input: afterInput,
    output,
    runtime: afterRuntime,
    mode: force ? 'forced-build' : 'ensure-build',
  });
  return {
    status: 'built',
    fresh: true,
    reason: force ? 'forced' : 'stale',
    manifest,
    input: afterInput,
    output,
    runtime: afterRuntime,
  };
}

export const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
