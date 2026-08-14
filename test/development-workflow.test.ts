import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  discoverWorkspaceProjects,
  includeDependents,
  isWorkspacePackageManifestPath,
  projectsForFiles,
  validateWorkspaceManifestGraphs,
} from '../scripts/workspace-projects.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function runGit(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

async function writeManifest(root: string, path: string, manifest: unknown) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function createWorkspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-workspace-graph-'));
  await writeManifest(root, 'packages/alpha/package.json', { name: '@fixture/alpha' });
  await writeManifest(root, 'packages/channels/webhook/package.json', { name: '@fixture/webhook' });
  runGit(root, ['init', '--quiet']);
  runGit(root, ['config', 'user.email', 'fixture@example.invalid']);
  runGit(root, ['config', 'user.name', 'LittleSheep Fixture']);
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '--quiet', '-m', 'fixture baseline']);
  return { root, mergeBase: runGit(root, ['rev-parse', 'HEAD']) };
}

describe('development workspace graph', () => {
  it('discovers every maintained package without descending into generated directories', async () => {
    const projects = await discoverWorkspaceProjects(repoRoot);
    expect(projects).toHaveLength(28);
    expect(projects.find((project) => project.name === '@littlesheep/app')?.tsconfigs).toEqual([
      'tsconfig.json',
      'tsconfig.web.json',
    ]);
    expect(projects.find((project) => project.name === '@littlesheep/embedding')?.tsconfigs)
      .toEqual(['tsconfig.json']);
    expect(projects.find((project) => project.name === '@littlesheep/documents')?.tsconfigs)
      .toEqual(['tsconfig.json']);
  });

  it('propagates a shared contract change to transitive dependents', async () => {
    const projects = await discoverWorkspaceProjects(repoRoot);
    const changed = projectsForFiles(projects, ['packages/types/src/runtime-contracts.ts']);
    const affected = includeDependents(projects, changed);

    expect(affected).toContain('@littlesheep/types');
    expect(affected).toContain('@littlesheep/harness');
    expect(affected).toContain('@littlesheep/runner');
    expect(affected).toContain('@littlesheep/app');
  });

  it('does not schedule package work for documentation-only changes', async () => {
    const projects = await discoverWorkspaceProjects(repoRoot);
    expect(projectsForFiles(projects, ['docs/decision/project-status.md'])).toEqual(new Set());
  });

  it('recognizes package manifests in both workspace roots', () => {
    expect(isWorkspacePackageManifestPath('packages/harness/package.json')).toBe(true);
    expect(isWorkspacePackageManifestPath('packages/channels/webhook/package.json')).toBe(true);
    expect(isWorkspacePackageManifestPath('package.json')).toBe(false);
    expect(isWorkspacePackageManifestPath('packages/harness/src/package.json')).toBe(false);
  });

  it('validates the base and working workspace manifest graphs before narrowing', async () => {
    const projects = await discoverWorkspaceProjects(repoRoot);
    const result = await validateWorkspaceManifestGraphs(repoRoot, 'HEAD', projects);
    expect(result.basePaths.length).toBeGreaterThan(0);
    expect(result.workingPaths.length).toBe(28);
    expect(result.workingPaths).toContain('packages/documents/package.json');
    expect(result.workingPaths).toContain('packages/channels/webhook/package.json');
    expect(result.pathChanges).toEqual({
      added: [],
      removed: [],
    });
    expect(result.pathSetChanged).toBe(false);
  });

  it('reports added and removed workspace manifest paths in an isolated repository', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      await rm(join(fixture.root, 'packages/alpha/package.json'));
      await writeManifest(fixture.root, 'packages/beta/package.json', { name: '@fixture/beta' });

      const projects = await discoverWorkspaceProjects(fixture.root);
      const result = await validateWorkspaceManifestGraphs(fixture.root, fixture.mergeBase, projects);

      expect(result.pathChanges).toEqual({
        added: ['packages/beta/package.json'],
        removed: ['packages/alpha/package.json'],
      });
      expect(result.pathSetChanged).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('accepts a package name and export contract change for full verification', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      await writeManifest(fixture.root, 'packages/alpha/package.json', {
        name: '@fixture/renamed-alpha',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': './dist/index.js' },
      });

      const projects = await discoverWorkspaceProjects(fixture.root);
      const result = await validateWorkspaceManifestGraphs(fixture.root, fixture.mergeBase, projects);

      expect(projects.map((project) => project.name)).toContain('@fixture/renamed-alpha');
      expect(result.pathSetChanged).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects malformed manifests and missing workspace dependencies', async () => {
    const malformed = await createWorkspaceFixture();
    try {
      await writeFile(join(malformed.root, 'packages/alpha/package.json'), '{ invalid json\n', 'utf8');
      await expect(validateWorkspaceManifestGraphs(malformed.root, malformed.mergeBase, []))
        .rejects.toThrow(/Cannot parse workspace package manifest/);
    } finally {
      await rm(malformed.root, { recursive: true, force: true });
    }

    const missingDependency = await createWorkspaceFixture();
    try {
      await writeManifest(missingDependency.root, 'packages/alpha/package.json', {
        name: '@fixture/alpha',
        dependencies: { '@fixture/missing': 'workspace:*' },
      });
      const projects = await discoverWorkspaceProjects(missingDependency.root);
      await expect(validateWorkspaceManifestGraphs(
        missingDependency.root,
        missingDependency.mergeBase,
        projects,
      )).rejects.toThrow(/references missing workspace package @fixture\/missing/);
    } finally {
      await rm(missingDependency.root, { recursive: true, force: true });
    }

    const malformedDependency = await createWorkspaceFixture();
    try {
      await writeManifest(malformedDependency.root, 'packages/alpha/package.json', {
        name: '@fixture/alpha',
        dependencies: { '@fixture/webhook': { range: 'workspace:*' } },
      });
      const projects = await discoverWorkspaceProjects(malformedDependency.root);
      await expect(validateWorkspaceManifestGraphs(
        malformedDependency.root,
        malformedDependency.mergeBase,
        projects,
      )).rejects.toThrow(/non-string dependencies value/);
    } finally {
      await rm(malformedDependency.root, { recursive: true, force: true });
    }
  });

});
