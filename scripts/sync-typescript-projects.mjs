import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProjectGraph,
  discoverWorkspaceProjects,
  normalizeRepoPath,
  projectReferencePath,
} from './workspace-projects.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const projects = await discoverWorkspaceProjects(repoRoot);
const { byName } = createProjectGraph(projects);
const stale = [];
const customBuildProjects = projects.filter(
  (project) => project.name !== '@littlesheep/app' && project.buildScript && !project.buildScript.startsWith('tsc '),
);

if (customBuildProjects.length > 0) {
  console.error(
    `Non-TypeScript package builds require explicit root build integration: ${customBuildProjects
      .map((project) => project.name)
      .join(', ')}`,
  );
  process.exit(1);
}

// Compare and write canonical LF content. A checkout may materialize CRLF on a
// Windows host (core.autocrlf) even though the repository stores LF; that is a
// property of the host, not a stale generated file. `.gitattributes` keeps the
// checkout LF, and this normalization keeps the check itself host-independent.
function normalizeEol(text) {
  return String(text).replace(/\r\n/gu, '\n');
}

async function syncJson(path, transform) {
  const current = normalizeEol(await readFile(path, 'utf8'));
  const parsed = JSON.parse(current);
  const next = `${JSON.stringify(transform(parsed), null, 2)}\n`;
  if (current === next) return;
  if (checkOnly) {
    stale.push(normalizeRepoPath(relative(repoRoot, path)));
    return;
  }
  await writeFile(path, next, 'utf8');
}

for (const project of projects) {
  for (const configName of project.tsconfigs) {
    const configPath = join(project.directory, configName);
    await syncJson(configPath, (config) => ({
      ...config,
      references: project.dependencies.map((name) => ({
        path: projectReferencePath(configPath, byName.get(name).directory),
      })),
    }));
  }
}

const solutionPath = join(repoRoot, 'tsconfig.workspace.json');
const solution = {
  files: [],
  references: projects.flatMap((project) =>
    project.tsconfigs.map((config) => ({
      path: normalizeRepoPath(relative(repoRoot, join(project.directory, config))),
    })),
  ),
};

let currentSolution = '';
try {
  currentSolution = normalizeEol(await readFile(solutionPath, 'utf8'));
} catch {
  // Created below.
}
const nextSolution = `${JSON.stringify(solution, null, 2)}\n`;
if (currentSolution !== nextSolution) {
  if (checkOnly) stale.push('tsconfig.workspace.json');
  else await writeFile(solutionPath, nextSolution, 'utf8');
}

if (stale.length > 0) {
  console.error(`TypeScript project references are stale: ${stale.join(', ')}`);
  console.error('Run: pnpm.cmd run sync:tsconfig');
  process.exit(1);
}

console.log(`TypeScript project references: ok (${projects.length} packages)`);
