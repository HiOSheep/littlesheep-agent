import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const WORKSPACE_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

export function normalizeRepoPath(value) {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function packageDirectories(repoRoot) {
  const roots = [join(repoRoot, 'packages'), join(repoRoot, 'packages', 'channels')];
  const directories = [];

  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name);
      if (await pathExists(join(directory, 'package.json'))) directories.push(directory);
    }
  }

  return directories.sort((left, right) => left.localeCompare(right));
}

export async function discoverWorkspaceProjects(repoRoot) {
  const directories = await packageDirectories(repoRoot);
  const manifests = [];

  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (!manifest.name) throw new Error(`Workspace package has no name: ${directory}`);
    manifests.push({ directory, manifest });
  }

  const names = new Set(manifests.map(({ manifest }) => manifest.name));
  return Promise.all(
    manifests.map(async ({ directory, manifest }) => {
      const dependencies = new Set();
      for (const section of WORKSPACE_SECTIONS) {
        for (const name of Object.keys(manifest[section] ?? {})) {
          if (names.has(name)) dependencies.add(name);
        }
      }

      const tsconfigs = ['tsconfig.json'];
      if (await pathExists(join(directory, 'tsconfig.web.json'))) tsconfigs.push('tsconfig.web.json');

      return {
        name: manifest.name,
        directory,
        relativeDirectory: normalizeRepoPath(relative(repoRoot, directory)),
        dependencies: [...dependencies].sort(),
        tsconfigs,
        buildScript: manifest.scripts?.build ?? null,
      };
    }),
  );
}

export function createProjectGraph(projects) {
  const byName = new Map(projects.map((project) => [project.name, project]));
  const dependents = new Map(projects.map((project) => [project.name, new Set()]));

  for (const project of projects) {
    for (const dependency of project.dependencies) {
      dependents.get(dependency)?.add(project.name);
    }
  }

  return { byName, dependents };
}

export function projectsForFiles(projects, files) {
  const ordered = [...projects].sort(
    (left, right) => right.relativeDirectory.length - left.relativeDirectory.length,
  );
  const matched = new Set();

  for (const rawFile of files) {
    const file = normalizeRepoPath(rawFile);
    const project = ordered.find(
      (candidate) => file === candidate.relativeDirectory || file.startsWith(`${candidate.relativeDirectory}/`),
    );
    if (project) matched.add(project.name);
  }

  return matched;
}

export function includeDependents(projects, initialNames) {
  const { dependents } = createProjectGraph(projects);
  const affected = new Set(initialNames);
  const queue = [...initialNames];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of dependents.get(current) ?? []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  return affected;
}

export function projectReferencePath(fromConfigPath, targetDirectory) {
  const value = normalizeRepoPath(relative(dirname(fromConfigPath), targetDirectory));
  return value.startsWith('.') ? value : `./${value}`;
}

export function projectConfigPaths(repoRoot, projects, names) {
  return projects
    .filter((project) => names.has(project.name))
    .flatMap((project) =>
      project.tsconfigs.map((config) => normalizeRepoPath(relative(repoRoot, resolve(project.directory, config)))),
    )
    .sort();
}

export function isWorkspacePackageManifestPath(file) {
  return /^packages\/(?:channels\/[^/]+|[^/]+)\/package\.json$/.test(normalizeRepoPath(file));
}

function gitLines(repoRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(`git ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}.${detail ? ` ${detail}` : ''}`);
  }
  return (result.stdout ?? '').split(/\r?\n/).map(normalizeRepoPath).filter(Boolean);
}

function parseJson(raw, pathLabel) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot parse workspace package manifest ${pathLabel}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateManifestEntries(entries, side) {
  const names = new Set();
  for (const { path, manifest } of entries) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || typeof manifest.name !== 'string' || !manifest.name.trim()) {
      throw new Error(`${side} workspace package manifest ${path} has no valid name.`);
    }
    if (names.has(manifest.name)) {
      throw new Error(`${side} workspace package graph contains duplicate package name ${manifest.name}.`);
    }
    names.add(manifest.name);
    for (const section of WORKSPACE_SECTIONS) {
      const value = manifest[section];
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
        throw new Error(`${side} workspace package manifest ${path} has invalid ${section}.`);
      }
    }
  }
  return names;
}

function validateWorkspaceDependencies(entries, names, side) {
  for (const { path, manifest } of entries) {
    for (const section of WORKSPACE_SECTIONS) {
      for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
        if (typeof version !== 'string') {
          throw new Error(`${side} workspace package manifest ${path} has non-string ${section} value for ${dependency}.`);
        }
        if (version.startsWith('workspace:') && !names.has(dependency)) {
          throw new Error(`${side} workspace package manifest ${path} references missing workspace package ${dependency}.`);
        }
      }
    }
  }
}

async function currentWorkspaceManifestPaths(repoRoot) {
  const paths = [];
  for (const directory of [join(repoRoot, 'packages'), join(repoRoot, 'packages', 'channels')]) {
    if (!(await pathExists(directory))) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(directory, entry.name, 'package.json');
      if (await pathExists(manifestPath)) paths.push(normalizeRepoPath(relative(repoRoot, manifestPath)));
    }
  }
  return paths.sort();
}

/**
 * Validate both sides of a workspace manifest change before narrowing tests.
 * Content changes are intentionally handled by the caller as changed-test and
 * global-typecheck invalidations; this helper only proves the graph can be read.
 */
export async function validateWorkspaceManifestGraphs(repoRoot, mergeBase, projects = []) {
  if (!mergeBase) throw new Error('Workspace manifest validation requires a resolved merge-base.');
  const basePaths = gitLines(repoRoot, ['ls-tree', '-r', '--name-only', mergeBase, '--', 'packages'])
    .filter(isWorkspacePackageManifestPath);
  const workingPaths = await currentWorkspaceManifestPaths(repoRoot);
  const projectPaths = new Set(projects.map((project) => `${project.relativeDirectory}/package.json`));

  const baseEntries = [];
  for (const path of basePaths) {
    const result = spawnSync('git', ['show', `${mergeBase}:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (result.error || result.status !== 0 || !result.stdout?.trim()) {
      throw new Error(`Cannot read workspace package manifest ${path} from merge-base ${mergeBase}.`);
    }
    baseEntries.push({ path, manifest: parseJson(result.stdout, `${mergeBase}:${path}`) });
  }

  const workingEntries = [];
  for (const path of workingPaths) {
    const absolute = resolve(repoRoot, path);
    const raw = await readFile(absolute, 'utf8').catch((error) => {
      throw new Error(`Cannot read workspace package manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
    });
    workingEntries.push({ path, manifest: parseJson(raw, path) });
  }

  const baseNames = validateManifestEntries(baseEntries, 'Base');
  const workingNames = validateManifestEntries(workingEntries, 'Working');
  validateWorkspaceDependencies(baseEntries, baseNames, 'Base');
  validateWorkspaceDependencies(workingEntries, workingNames, 'Working');

  // A manifest path that exists on disk but was omitted from discovery means
  // the current graph is not trustworthy (for example, a malformed/missing name).
  if (projectPaths.size !== workingPaths.length || [...projectPaths].some((path) => !workingPaths.includes(path))) {
    throw new Error('Current workspace package manifest graph is incomplete.');
  }
  const basePathSet = new Set(basePaths);
  const workingPathSet = new Set(workingPaths);
  const pathChanges = {
    added: workingPaths.filter((path) => !basePathSet.has(path)),
    removed: basePaths.filter((path) => !workingPathSet.has(path)),
  };
  return {
    basePaths,
    workingPaths,
    pathChanges,
    pathSetChanged: pathChanges.added.length > 0 || pathChanges.removed.length > 0,
  };
}
