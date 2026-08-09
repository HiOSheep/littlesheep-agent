import { resolve } from 'node:path';
import {
  assertWorkspaceArtifacts,
  ensureWorkspaceArtifacts,
} from './lib/workspace-artifact-fingerprint.mjs';

const repoRootArg = process.argv.find((value) => value.startsWith('--repo-root='));
const repoRoot = resolve(repoRootArg?.slice('--repo-root='.length) ?? process.cwd());
const assertOnly = process.argv.includes('--assert');
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

if (targets.length === 0) {
  console.error('Usage: node scripts/ensure-workspace-artifacts.mjs --package=<workspace-package> [--package=<...>] [--assert]');
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
