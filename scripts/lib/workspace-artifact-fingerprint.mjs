import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  access,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { discoverWorkspaceProjects } from '../workspace-projects.mjs';

export const WORKSPACE_ARTIFACT_SCHEMA = 'littlesheep.workspace-artifact-fingerprint';
export const WORKSPACE_ARTIFACT_VERSION = 1;
export const WORKSPACE_ARTIFACT_SIDECAR = '.littlesheep-build-fingerprint.json';

const ROOT_INPUTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.workspace.json',
];
const PACKAGE_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const EXCLUDED_DIRECTORY_NAMES = new Set(['dist', 'node_modules', '.git', '.cache', 'out']);
const EXCLUDED_FILE_NAMES = new Set(['.littlesheep-build-fingerprint.json']);
const EXCLUDED_FILE_SUFFIXES = ['.tsbuildinfo'];
const PROJECT_INPUT_DIRECTORIES = new Set(['src', 'resources', 'public']);
const PROJECT_CONFIG_FILE = /^(?:tsconfig(?:\.[^.]+)?\.json|(?:electron\.)?vite\.config\.[cm]?[jt]s|(?:rollup|webpack|esbuild|build)\.config\.[cm]?[jt]s|build\.[cm]?[jt]s)$/u;

export class WorkspaceArtifactFreshnessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WorkspaceArtifactFreshnessError';
    this.code = 'WORKSPACE_ARTIFACT_NOT_FRESH';
    Object.assign(this, details);
  }
}

export class WorkspaceArtifactContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WorkspaceArtifactContractError';
    this.code = 'WORKSPACE_ARTIFACT_CONTRACT_INVALID';
    Object.assign(this, details);
  }
}

function normalizeRepoPath(value) {
  return value.split(sep).join('/').replace(/^\.\//u, '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathInside(root, candidate, label) {
  const rootAbsolute = resolve(root);
  const candidateAbsolute = resolve(candidate);
  const rel = relative(rootAbsolute, candidateAbsolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new WorkspaceArtifactContractError(`${label} escapes repository boundary: ${candidateAbsolute}`);
  }
  return candidateAbsolute;
}

async function existingPath(path, label) {
  try {
    await access(path);
  } catch {
    throw new WorkspaceArtifactContractError(`Required ${label} is missing: ${path}`);
  }
}

async function assertRealPathInside(root, path, label) {
  pathInside(root, path, label);
  let resolvedPath;
  try {
    resolvedPath = await realpath(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new WorkspaceArtifactContractError(`Required ${label} is missing: ${path}`, {
        missing: true,
        cause: error,
      });
    }
    throw new WorkspaceArtifactContractError(`Cannot resolve ${label}: ${path}`, { cause: error });
  }
  pathInside(root, resolvedPath, label);
  return resolvedPath;
}

async function assertRegularFile(path, label, root) {
  await assertRealPathInside(root, path, label);
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw new WorkspaceArtifactContractError(`Required ${label} is missing: ${path}`, {
        missing: true,
        cause: error,
      });
    }
    throw new WorkspaceArtifactContractError(`Cannot inspect ${label}: ${path}`, { cause: error });
  });
  if (info.isSymbolicLink()) {
    throw new WorkspaceArtifactContractError(`Symlink is not allowed for ${label}: ${path}`);
  }
  if (!info.isFile()) {
    throw new WorkspaceArtifactContractError(`${label} is not a regular file: ${path}`);
  }
  return info;
}

async function assertDirectory(path, label, root) {
  await assertRealPathInside(root, path, label);
  const info = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw new WorkspaceArtifactContractError(`Required ${label} is missing: ${path}`, {
        missing: true,
        cause: error,
      });
    }
    throw new WorkspaceArtifactContractError(`Cannot inspect ${label}: ${path}`, { cause: error });
  });
  if (info.isSymbolicLink()) {
    throw new WorkspaceArtifactContractError(`Symlink is not allowed for ${label}: ${path}`);
  }
  if (!info.isDirectory()) {
    throw new WorkspaceArtifactContractError(`${label} is not a directory: ${path}`);
  }
  return info;
}

async function readJson(path, label, root) {
  await assertRegularFile(path, label, root);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new WorkspaceArtifactContractError(`Cannot read ${label}: ${path}`, { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new WorkspaceArtifactContractError(`Cannot parse ${label}: ${path}`, { cause: error });
  }
}

function digestJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function digestFile(path, root) {
  await assertRegularFile(path, 'fingerprint input', root);
  const content = await readFile(path);
  return {
    path: normalizeRepoPath(relative(root, path)),
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: content.byteLength,
  };
}

function shouldSkipFile(name) {
  return EXCLUDED_FILE_NAMES.has(name) || EXCLUDED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function walkRegularFiles(root, directory, options = {}) {
  await assertDirectory(directory, options.label ?? 'directory', root);
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const item = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (options.skipDirectories?.has(entry.name)) continue;
      files.push(...await walkRegularFiles(root, item, options));
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (options.allowSymlinkNames?.has(entry.name)) continue;
      throw new WorkspaceArtifactContractError(`Symlink is not allowed in ${options.label ?? 'directory'}: ${item}`);
    }
    if (!entry.isFile()) {
      throw new WorkspaceArtifactContractError(`Unsupported filesystem entry in ${options.label ?? 'directory'}: ${item}`);
    }
    if (shouldSkipFile(entry.name) || options.skipFiles?.has(entry.name)) continue;
    files.push(await digestFile(item, root));
  }
  return files;
}

async function collectProjectInputFiles(plan, project) {
  const files = [await digestFile(join(project.directory, 'package.json'), plan.repoRoot)];
  const entries = await readdir(project.directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const item = join(project.directory, entry.name);
    if (entry.isDirectory()) {
      if (!PROJECT_INPUT_DIRECTORIES.has(entry.name)) continue;
      files.push(...await walkRegularFiles(plan.repoRoot, item, {
        label: `${project.name} ${entry.name}`,
        skipDirectories: EXCLUDED_DIRECTORY_NAMES,
      }));
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new WorkspaceArtifactContractError(`Symlink is not allowed in ${project.name} build inputs: ${item}`);
    }
    if (!entry.isFile() || shouldSkipFile(entry.name)) continue;
    if (PROJECT_CONFIG_FILE.test(entry.name)) {
      files.push(await digestFile(item, plan.repoRoot));
    }
  }
  // Keep the input set conservative. A package's generated output is governed
  // by its tsconfig, so test/spec sources stay included unless that contract
  // explicitly excludes them.
  return files;
}

function stableFiles(files) {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

function snapshotDigest(files) {
  return digestJson(stableFiles(files).map(({ path, sha256, bytes }) => ({ path, sha256, bytes })));
}

function packageEntryPaths(manifest) {
  const paths = [];
  const add = (value) => {
    if (typeof value === 'string') paths.push(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (isPlainObject(value)) Object.values(value).forEach(add);
  };
  add(manifest.main);
  add(manifest.module);
  add(manifest.types);
  add(manifest.exports);
  return [...new Set(paths)];
}

function relativePackagePath(packageDirectory, value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WorkspaceArtifactContractError(`${label} must be a non-empty string.`);
  }
  if (isAbsolute(value)) {
    throw new WorkspaceArtifactContractError(`${label} must be relative: ${value}`);
  }
  const normalized = value.replace(/^\.\//u, '');
  const absolute = resolve(packageDirectory, normalized);
  pathInside(packageDirectory, absolute, label);
  return absolute;
}

async function validateProjectManifest(project, allNames, repoRoot) {
  const manifestPath = join(project.directory, 'package.json');
  const manifest = await readJson(manifestPath, `${project.name} package manifest`, repoRoot);
  if (!isPlainObject(manifest) || manifest.name !== project.name) {
    throw new WorkspaceArtifactContractError(`Workspace manifest identity mismatch: ${manifestPath}`);
  }
  if (!isPlainObject(manifest.scripts) || typeof manifest.scripts.build !== 'string' || !manifest.scripts.build.trim()) {
    throw new WorkspaceArtifactContractError(`Workspace package ${project.name} has no usable build script.`);
  }
  const dependencies = new Set();
  for (const section of PACKAGE_SECTIONS) {
    const values = manifest[section];
    if (values !== undefined && !isPlainObject(values)) {
      throw new WorkspaceArtifactContractError(`Workspace package ${project.name} has invalid ${section}.`);
    }
    for (const [name, version] of Object.entries(values ?? {})) {
      if (typeof version !== 'string') {
        throw new WorkspaceArtifactContractError(`Workspace package ${project.name} has non-string ${section} value for ${name}.`);
      }
      if (allNames.has(name)) dependencies.add(name);
      if (version.startsWith('workspace:') && !allNames.has(name)) {
        throw new WorkspaceArtifactContractError(`Workspace package ${project.name} references missing package ${name}.`);
      }
    }
  }
  const entries = packageEntryPaths(manifest);
  if (entries.length === 0) {
    throw new WorkspaceArtifactContractError(`Workspace package ${project.name} has no runtime/type entry.`);
  }
  return { ...project, manifest, dependencies: [...dependencies].sort(), entries };
}

export async function resolveWorkspaceBuildPlan({ repoRoot, targetNames }) {
  const root = resolve(repoRoot);
  if (!Array.isArray(targetNames) || targetNames.length === 0) {
    throw new WorkspaceArtifactContractError('At least one workspace target package is required.');
  }
  const targets = [...new Set(targetNames)].filter((value) => typeof value === 'string' && value.trim()).sort();
  if (targets.length !== targetNames.length) {
    throw new WorkspaceArtifactContractError('Workspace target package names must be unique non-empty strings.');
  }
  for (const input of ROOT_INPUTS) {
    const path = join(root, input);
    await existingPath(path, input);
    await assertRegularFile(path, input, root);
  }
  let discovered;
  try {
    discovered = await discoverWorkspaceProjects(root);
  } catch (error) {
    throw new WorkspaceArtifactContractError(
      `Workspace project discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const names = new Set(discovered.map((project) => project.name));
  if (names.size !== discovered.length) {
    throw new WorkspaceArtifactContractError('Workspace package names must be unique.');
  }
  for (const target of targets) {
    if (!names.has(target)) throw new WorkspaceArtifactContractError(`Unknown workspace target package: ${target}`);
  }
  const byName = new Map();
  for (const project of discovered) {
    await assertDirectory(project.directory, `${project.name} package directory`, root);
    byName.set(project.name, await validateProjectManifest(project, names, root));
  }
  const closure = new Set();
  const queue = [...targets];
  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name)) continue;
    closure.add(name);
    for (const dependency of byName.get(name).dependencies) queue.push(dependency);
  }
  const projects = [...closure].sort().map((name) => byName.get(name));
  return {
    repoRoot: root,
    targetNames: targets,
    closureNames: projects.map((project) => project.name),
    projects,
  };
}

async function collectInputSnapshot(plan) {
  const files = [];
  for (const rootInput of ROOT_INPUTS) files.push(await digestFile(join(plan.repoRoot, rootInput), plan.repoRoot));
  for (const project of plan.projects) {
    files.push(...await collectProjectInputFiles(plan, project));
  }
  const stable = stableFiles(files);
  return { digest: snapshotDigest(stable), files: stable };
}

async function collectArtifactSnapshot(plan) {
  const files = [];
  const missing = [];
  const entries = [];
  for (const project of plan.projects) {
    const dist = join(project.directory, 'dist');
    try {
      await assertDirectory(dist, `${project.name} dist`, plan.repoRoot);
    } catch (error) {
      if (error instanceof WorkspaceArtifactContractError && error.missing) {
        missing.push(`${project.name}:dist`);
        continue;
      }
      throw error;
    }
    const packageFiles = await walkRegularFiles(plan.repoRoot, dist, {
      label: `${project.name} dist`,
      skipDirectories: new Set(),
    });
    files.push(...packageFiles);
    for (const entry of project.entries) {
      const entryPath = relativePackagePath(project.directory, entry, `${project.name} entry`);
      const entryRelative = normalizeRepoPath(relative(project.directory, entryPath));
      if (!entryRelative.startsWith('dist/')) {
        throw new WorkspaceArtifactContractError(`${project.name} entry must resolve inside dist/: ${entry}`);
      }
      try {
        await assertRegularFile(entryPath, `${project.name} entry`, plan.repoRoot);
        entries.push({ package: project.name, path: entryRelative });
      } catch (error) {
        if (error instanceof WorkspaceArtifactContractError && error.missing) {
          missing.push(`${project.name}:${entryRelative}`);
          continue;
        }
        throw error;
      }
    }
  }
  const stable = stableFiles(files);
  return {
    digest: snapshotDigest(stable),
    files: stable,
    entries: entries.sort((left, right) => `${left.package}/${left.path}`.localeCompare(`${right.package}/${right.path}`)),
    missing,
  };
}

function sidecarPath(plan, targetName) {
  const project = plan.projects.find((value) => value.name === targetName);
  if (!project) throw new WorkspaceArtifactContractError(`Target is not in workspace build plan: ${targetName}`);
  const dist = pathInside(project.directory, join(project.directory, 'dist'), `${targetName} dist`);
  return pathInside(dist, join(dist, WORKSPACE_ARTIFACT_SIDECAR), `${targetName} workspace fingerprint`);
}

async function readSidecar(plan, targetName) {
  const path = sidecarPath(plan, targetName);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new WorkspaceArtifactContractError(`Workspace fingerprint sidecar cannot be a symlink: ${path}`);
    if (!info.isFile()) throw new WorkspaceArtifactContractError(`Workspace fingerprint sidecar is not a file: ${path}`);
    await assertRealPathInside(plan.repoRoot, path, `${targetName} workspace fingerprint`);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof WorkspaceArtifactContractError) throw error;
    if (error instanceof SyntaxError) return { __invalid: true };
    throw new WorkspaceArtifactContractError(`Cannot read workspace fingerprint sidecar: ${path}`, { cause: error });
  }
}

function compareFiles(expected, actual) {
  return JSON.stringify(stableFiles(expected ?? [])) === JSON.stringify(stableFiles(actual ?? []));
}

function sidecarMatches(sidecar, plan, inputs, artifacts) {
  if (sidecar === null) return { ok: false, reasons: ['manifest-missing'] };
  if (!isPlainObject(sidecar) || sidecar.__invalid) return { ok: false, reasons: ['manifest-invalid'] };
  if (sidecar.schema !== WORKSPACE_ARTIFACT_SCHEMA || sidecar.version !== WORKSPACE_ARTIFACT_VERSION) {
    return { ok: false, reasons: ['manifest-schema-mismatch'] };
  }
  const reasons = [];
  if (JSON.stringify(sidecar.targetNames) !== JSON.stringify(plan.targetNames)) reasons.push('target-set-mismatch');
  if (JSON.stringify(sidecar.closureNames) !== JSON.stringify(plan.closureNames)) reasons.push('dependency-closure-mismatch');
  if (sidecar.inputs?.digest !== inputs.digest || !compareFiles(sidecar.inputs?.files, inputs.files)) reasons.push('input-stale');
  if (sidecar.artifacts?.digest !== artifacts.digest || !compareFiles(sidecar.artifacts?.files, artifacts.files)) reasons.push('artifact-tampered');
  if (artifacts.missing.length > 0) reasons.push('artifact-missing');
  if (JSON.stringify(sidecar.entries ?? []) !== JSON.stringify(artifacts.entries)) reasons.push('required-entry-mismatch');
  return { ok: reasons.length === 0, reasons };
}

export async function inspectWorkspaceArtifacts(options) {
  const plan = await resolveWorkspaceBuildPlan(options);
  const inputs = await collectInputSnapshot(plan);
  const artifacts = await collectArtifactSnapshot(plan);
  const sidecars = {};
  const reasons = new Set();
  for (const targetName of plan.targetNames) {
    const sidecar = await readSidecar(plan, targetName);
    sidecars[targetName] = sidecar;
    const result = sidecarMatches(sidecar, plan, inputs, artifacts);
    result.reasons.forEach((reason) => reasons.add(reason));
  }
  return {
    fresh: reasons.size === 0,
    reasons: [...reasons],
    plan,
    inputs,
    artifacts,
    sidecars,
  };
}

export async function assertWorkspaceArtifacts(options) {
  const inspection = await inspectWorkspaceArtifacts(options);
  if (!inspection.fresh) {
    throw new WorkspaceArtifactFreshnessError(
      `Workspace artifacts are not fresh for ${inspection.plan.targetNames.join(', ')}: ${inspection.reasons.join(', ')}`,
      inspection,
    );
  }
  return inspection;
}

function defaultBuildRunner(plan, options) {
  const pnpmCommand = options.pnpmCommand ?? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  const args = [];
  for (const targetName of plan.targetNames) args.push('--filter', `${targetName}...`);
  args.push('run', 'build');
  const invocation = process.platform === 'win32' && pnpmCommand.toLowerCase().endsWith('.cmd')
    ? {
      command: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      args: ['/d', '/s', '/c', pnpmCommand, ...args],
    }
    : { command: pnpmCommand, args };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: plan.repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new WorkspaceArtifactContractError(
      `Workspace build failed with exit ${result.status ?? 'unknown'}.`,
      { buildFailed: true },
    );
  }
  return { command: invocation.command, args: invocation.args, displayCommand: [pnpmCommand, ...args] };
}

async function writeAtomicJson(path, value, root) {
  const directory = dirname(path);
  await assertDirectory(directory, 'workspace artifact sidecar directory', root);
  const temporary = join(directory, `.${WORKSPACE_ARTIFACT_SIDECAR}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporary, path);
  } catch (error) {
    // Windows does not replace an existing file with rename. Remove only the
    // exact validated sidecar and retry; no broad directory operation occurs.
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeSidecars(plan, inputs, artifacts, build) {
  const generatedAt = new Date().toISOString();
  for (const targetName of plan.targetNames) {
    const path = sidecarPath(plan, targetName);
    const value = {
      schema: WORKSPACE_ARTIFACT_SCHEMA,
      version: WORKSPACE_ARTIFACT_VERSION,
      generatedAt,
      targetNames: plan.targetNames,
      closureNames: plan.closureNames,
      inputs,
      artifacts: {
        digest: artifacts.digest,
        files: artifacts.files,
      },
      entries: artifacts.entries,
      build: build ?? null,
    };
    await writeAtomicJson(path, value, plan.repoRoot);
  }
}

export async function ensureWorkspaceArtifacts(options) {
  const initial = await inspectWorkspaceArtifacts(options);
  if (initial.fresh) return { ...initial, status: 'reused', build: null };

  const beforeInputs = initial.inputs;
  let build;
  try {
    build = options.runBuild
      ? await options.runBuild({
        repoRoot: initial.plan.repoRoot,
        targetNames: initial.plan.targetNames,
        closureNames: initial.plan.closureNames,
      })
      : defaultBuildRunner(initial.plan, options);
  } catch (error) {
    if (error instanceof WorkspaceArtifactContractError && error.buildFailed) throw error;
    throw new WorkspaceArtifactContractError(
      `Workspace build failed: ${error instanceof Error ? error.message : String(error)}`,
      { buildFailed: true, cause: error, initial },
    );
  }
  const after = await inspectWorkspaceArtifacts(options);
  if (after.inputs.digest !== beforeInputs.digest || !compareFiles(after.inputs.files, beforeInputs.files)) {
    throw new WorkspaceArtifactContractError('Workspace inputs changed during build; fingerprint was not recorded.', {
      buildFailed: false,
      inputsChangedDuringBuild: true,
    });
  }
  if (after.artifacts.missing.length > 0) {
    throw new WorkspaceArtifactContractError(`Workspace build completed without required artifacts: ${after.artifacts.missing.join(', ')}`, {
      buildFailed: false,
      artifactMissingAfterBuild: after.artifacts.missing,
    });
  }
  await writeSidecars(initial.plan, beforeInputs, after.artifacts, build);
  const verified = await assertWorkspaceArtifacts(options);
  return { ...verified, status: 'built', build };
}

export function workspaceBuildCommand({ targetNames, pnpmCommand } = {}) {
  const command = pnpmCommand ?? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  const args = [];
  for (const targetName of targetNames ?? []) args.push('--filter', `${targetName}...`);
  args.push('run', 'build');
  return { command, args };
}
