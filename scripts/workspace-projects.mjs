import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

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
