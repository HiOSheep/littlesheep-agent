import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceArtifacts,
  ensureWorkspaceArtifacts,
  inspectWorkspaceArtifacts,
  workspaceBuildCommand,
  WorkspaceArtifactContractError,
  WorkspaceArtifactFreshnessError,
} from './workspace-artifact-fingerprint.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-workspace-artifact-'));
  await writeFile(join(root, 'package.json'), '{"name":"fixture","private":true}\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  await writeFile(join(root, 'tsconfig.base.json'), '{"compilerOptions":{"target":"ES2022"}}\n');
  await writeFile(join(root, 'tsconfig.workspace.json'), '{"files":[]}\n');
  await addPackage(root, 'base', [], 'export const base = 1;\n');
  await addPackage(root, 'consumer', ['base'], 'import { base } from "@fixture/base"; export const value = base + 1;\n');
  return root;
}

async function addPackage(root, name, dependencies, source) {
  const directory = join(root, 'packages', name);
  await mkdir(join(directory, 'src'), { recursive: true });
  const dependencyObject = Object.fromEntries(dependencies.map((value) => [`@fixture/${value}`, 'workspace:*']));
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: `@fixture/${name}`,
    version: '1.0.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    dependencies: dependencyObject,
    scripts: { build: 'fixture-build' },
  }, null, 2)}\n`);
  await writeFile(join(directory, 'tsconfig.json'), '{"extends":"../../tsconfig.base.json","compilerOptions":{"outDir":"./dist","rootDir":"./src"},"include":["src/**/*"]}\n');
  await writeFile(join(directory, 'src', 'index.ts'), source);
}

async function fakeBuild({ repoRoot, targetNames }) {
  for (const name of ['base', 'consumer']) {
    const packageDirectory = join(repoRoot, 'packages', name);
    await mkdir(join(packageDirectory, 'dist'), { recursive: true });
  }
  // The fixture intentionally builds the complete closure, like pnpm's
  // `--filter <target>...` selector does.
  for (const name of ['base', 'consumer']) {
    const packageDirectory = join(repoRoot, 'packages', name);
    const source = await readFile(join(packageDirectory, 'src', 'index.ts'), 'utf8');
    await writeFile(join(packageDirectory, 'dist', 'index.js'), `${source}\n`);
    await writeFile(join(packageDirectory, 'dist', 'index.d.ts'), `export declare const ${name === 'base' ? 'base' : 'value'}: number;\n`);
  }
  return { command: 'fixture-build', args: targetNames };
}

describe('workspace artifact freshness', () => {
  it('builds the requested dependency closure in one pnpm invocation', () => {
    expect(workspaceBuildCommand({
      targetNames: ['@fixture/consumer', '@fixture/base'],
      pnpmCommand: 'pnpm-test',
    })).toEqual({
      command: 'pnpm-test',
      args: ['--filter', '@fixture/consumer...', '--filter', '@fixture/base...', 'run', 'build'],
    });
  });

  it('resolves the full dependency closure and records a reusable sidecar', async () => {
    const root = await fixture();
    try {
      const first = await ensureWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'], runBuild: fakeBuild });
      expect(first.status).toBe('built');
      expect(first.plan.closureNames).toEqual(['@fixture/base', '@fixture/consumer']);
      expect(first.inputs.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(first.artifacts.files.length).toBe(4);
      const second = await ensureWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'], runBuild: async () => { throw new Error('should reuse'); } });
      expect(second.status).toBe('reused');
      await expect(assertWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'] })).resolves.toMatchObject({ fresh: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('invalidates when an upstream source changes', async () => {
    const root = await fixture();
    try {
      await ensureWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'], runBuild: fakeBuild });
      await writeFile(join(root, 'packages', 'base', 'src', 'index.ts'), 'export const base = 2;\n');
      const inspection = await inspectWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'] });
      expect(inspection.fresh).toBe(false);
      expect(inspection.reasons).toContain('input-stale');
      await expect(assertWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'] })).rejects.toBeInstanceOf(WorkspaceArtifactFreshnessError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects missing or tampered dist entries', async () => {
    const root = await fixture();
    try {
      await ensureWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'], runBuild: fakeBuild });
      await rm(join(root, 'packages', 'base', 'dist', 'index.js'));
      expect((await inspectWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'] })).reasons).toContain('artifact-tampered');
      expect((await inspectWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'] })).reasons).toContain('required-entry-mismatch');
      await fakeBuild({ repoRoot: root, targetNames: ['@fixture/consumer'] });
      await writeFile(join(root, 'packages', 'base', 'dist', 'index.js'), 'tampered\n');
      expect((await inspectWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'] })).reasons).toContain('artifact-tampered');
      await rm(join(root, 'packages', 'base', 'dist'), { recursive: true, force: true });
      expect((await inspectWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'] })).reasons).toContain('artifact-missing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a target-set mismatch instead of reusing a narrower request', async () => {
    const root = await fixture();
    try {
      await ensureWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/base', '@fixture/consumer'], runBuild: fakeBuild });
      const inspection = await inspectWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'] });
      expect(inspection.fresh).toBe(false);
      expect(inspection.reasons).toContain('target-set-mismatch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not write a sidecar when the build fails or inputs change during build', async () => {
    const root = await fixture();
    try {
      await expect(ensureWorkspaceArtifacts({
        repoRoot: root,
        targetNames: ['@fixture/consumer'],
        runBuild: async () => { throw new Error('build failed'); },
      })).rejects.toThrow('build failed');
      const sidecar = join(root, 'packages', 'consumer', 'dist', '.littlesheep-build-fingerprint.json');
      await expect(readFile(sidecar, 'utf8')).rejects.toThrow();
      await expect(ensureWorkspaceArtifacts({
        repoRoot: root,
        targetNames: ['@fixture/consumer'],
        runBuild: async ({ repoRoot }) => {
          await fakeBuild({ repoRoot, targetNames: ['@fixture/consumer'] });
          await writeFile(join(repoRoot, 'packages', 'base', 'src', 'index.ts'), 'changed while building\n');
        },
      })).rejects.toMatchObject({ code: 'WORKSPACE_ARTIFACT_CONTRACT_INVALID', buildFailed: false });
      await expect(readFile(sidecar, 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for symlinked source and out-of-dist entries', async () => {
    const root = await fixture();
    try {
      const outside = join(root, 'outside.ts');
      await writeFile(outside, 'export const outside = true;\n');
      const symlink = join(root, 'packages', 'base', 'src', 'linked.ts');
      try {
        await (await import('node:fs/promises')).symlink(outside, symlink);
      } catch (error) {
        if (error?.code === 'EPERM') return;
        throw error;
      }
      await expect(inspectWorkspaceArtifacts({ repoRoot: root, targetNames: ['@fixture/consumer'] })).rejects.toBeInstanceOf(WorkspaceArtifactContractError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
