import { resolve } from 'node:path';
import {
  assertWorkspaceArtifacts,
  ensureWorkspaceArtifacts,
} from './lib/workspace-artifact-fingerprint.mjs';
import { discoverWorkspaceProjects } from './workspace-projects.mjs';

const repoRootArg = process.argv.find((value) => value.startsWith('--repo-root='));
const repoRoot = resolve(repoRootArg?.slice('--repo-root='.length) ?? process.cwd());
const assertOnly = process.argv.includes('--assert');
const wholeWorkspace = process.argv.includes('--workspace');
const targets = [];
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (value === '--package') {
    const next = process.argv[++index];
    if (next) targets.push(next);
  } else if (value?.startsWith('--package=')) {
    targets.push(value.slice('--package='.length));
  }
}

// A clean runner needs every library artifact, not only the packages whose
// absence happened to break one suite: scripts spawn node entry points that
// import package dist/ files directly, and the Electron app build reads the
// same artifacts. `@littlesheep/app` is excluded because its custom
// electron-vite build is covered by `build:app` later in the gate.
if (wholeWorkspace) {
  const projects = await discoverWorkspaceProjects(repoRoot);
  for (const project of projects) {
    if (project.name !== '@littlesheep/app') targets.push(project.name);
  }
}

if (targets.length === 0) {
  console.error('Usage: node scripts/ensure-workspace-artifacts.mjs (--package=<workspace-package> | --workspace) [--assert]');
  process.exit(2);
}

try {
  const result = assertOnly
    ? await assertWorkspaceArtifacts({ repoRoot, targetNames: targets })
    : await ensureWorkspaceArtifacts({ repoRoot, targetNames: targets });
  console.log(JSON.stringify({
    status: assertOnly ? 'fresh' : result.status,
    targetNames: result.plan.targetNames,
    closureNames: result.plan.closureNames,
    inputDigest: result.inputs.digest,
    artifactDigest: result.artifacts.digest,
    reasons: result.reasons,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: 'failed',
    code: error?.code ?? 'WORKSPACE_ARTIFACT_ERROR',
    message: error instanceof Error ? error.message : String(error),
    reasons: error?.reasons ?? [],
  }, null, 2));
  process.exit(1);
}
