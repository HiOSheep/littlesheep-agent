import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appBuildManifestPath,
  assertAppBuildFresh,
  collectAppBuildInputs,
  ensureAppBuild,
  fingerprintAppBuildOutputs,
  inspectAppBuildFreshness,
} from './app-build-fingerprint.mjs';
import { fingerprintPreparedElectronRuntime } from './electron-runtime.mjs';

const roots = [];

async function write(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, 'utf8');
}

async function manifest(root, path, value) {
  await write(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-app-build-fingerprint-'));
  roots.push(root);
  await Promise.all([
    manifest(root, 'package.json', { name: 'fixture', private: true }),
    write(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'),
    write(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n"),
    write(join(root, 'tsconfig.base.json'), '{}\n'),
    write(join(root, 'tsconfig.workspace.json'), '{}\n'),
    write(join(root, 'scripts/prepare-littlesheep-runtime.mjs'), 'export {}\n'),
    write(join(root, 'scripts/workspace-projects.mjs'), 'export {}\n'),
    write(join(root, 'scripts/ensure-app-build.mjs'), 'export {}\n'),
    write(join(root, 'scripts/ensure-workspace-artifacts.mjs'), 'export {}\n'),
    write(join(root, 'scripts/run-verified-electron.mjs'), 'export {}\n'),
    cp(new URL('./build-fingerprint.mjs', import.meta.url), join(root, 'scripts/lib/build-fingerprint.mjs')),
    cp(new URL('./electron-runtime.mjs', import.meta.url), join(root, 'scripts/lib/electron-runtime.mjs')),
    cp(new URL('./app-build-fingerprint.mjs', import.meta.url), join(root, 'scripts/lib/app-build-fingerprint.mjs')),
    cp(new URL('./workspace-artifact-fingerprint.mjs', import.meta.url), join(root, 'scripts/lib/workspace-artifact-fingerprint.mjs')),
  ]);
  await manifest(root, 'packages/app/package.json', {
    name: '@littlesheep/app',
    devDependencies: { '@fixture/alpha': 'workspace:*' },
  });
  await manifest(root, 'packages/alpha/package.json', {
    name: '@fixture/alpha',
    dependencies: { '@fixture/beta': 'workspace:*' },
  });
  await manifest(root, 'packages/beta/package.json', { name: '@fixture/beta' });
  for (const packagePath of ['app', 'alpha', 'beta']) {
    await write(join(root, 'packages', packagePath, 'tsconfig.json'), '{}\n');
    await write(join(root, 'packages', packagePath, 'src/index.ts'), `export const name = '${packagePath}'\n`);
  }
  await write(join(root, 'packages/app/electron.vite.config.ts'), 'export default {}\n');

  const installationRoot = join(root, '.electron-fixture');
  const sourceExecutable = join(installationRoot, 'dist', 'electron.exe');
  await write(sourceExecutable, 'electron-binary');
  const runtimeDirectory = join(
    root,
    'packages/app/runtime',
    `electron-v1.2.3-${process.platform}-${process.arch}`,
  );
  const runtimePath = join(runtimeDirectory, 'LittleSheep.exe');
  await Promise.all([
    write(runtimePath, 'electron-binary'),
    write(join(runtimeDirectory, 'version'), '1.2.3\n'),
    write(join(runtimeDirectory, 'resources/default_app.asar'), 'asar'),
    mkdir(join(runtimeDirectory, 'locales'), { recursive: true }),
  ]);
  const installation = {
    version: '1.2.3',
    packageRoot: installationRoot,
    executablePath: sourceExecutable,
  };
  const resolveRuntime = (repoRoot, path) => fingerprintPreparedElectronRuntime(
    repoRoot,
    path,
    { installation },
  );
  const prepareRuntime = vi.fn(async () => runtimePath);

  async function writeOutputs() {
    await Promise.all([
      write(join(root, 'packages/app/out/main/index.js'), 'main-output'),
      write(join(root, 'packages/app/out/preload/index.js'), 'preload-output'),
      write(join(root, 'packages/app/out/renderer/index.html'), '<!doctype html>'),
      write(join(root, 'packages/app/out/renderer/assets/app.js'), 'renderer-output'),
    ]);
  }

  return { root, runtimePath, resolveRuntime, prepareRuntime, writeOutputs };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('App build fingerprint', () => {
  it('includes transitive workspace source in the App input closure', async () => {
    const fixture = await createFixture();
    const runtime = await fixture.resolveRuntime(fixture.root, fixture.runtimePath);
    const before = await collectAppBuildInputs(fixture.root, runtime);
    expect(before.workspacePackages).toEqual([
      '@fixture/alpha',
      '@fixture/beta',
      '@littlesheep/app',
    ]);

    await write(join(fixture.root, 'packages/beta/src/index.ts'), 'export const name = "changed"\n');
    const after = await collectAppBuildInputs(fixture.root, runtime);
    expect(after.digest).not.toBe(before.digest);
  });

  it('builds once, records a sidecar, and reuses matching artifacts', async () => {
    const fixture = await createFixture();
    const build = vi.fn(fixture.writeOutputs);

    const first = await ensureAppBuild(fixture.root, {
      prepareRuntime: fixture.prepareRuntime,
      resolveRuntime: fixture.resolveRuntime,
      build,
      ensureWorkspaceBuild: async () => {},
    });
    expect(first.status).toBe('built');
    expect(build).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(appBuildManifestPath(fixture.root), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      kind: 'littlesheep-app-build',
      runtime: { electronVersion: '1.2.3', platform: process.platform, arch: process.arch },
    });

    const second = await ensureAppBuild(fixture.root, {
      prepareRuntime: fixture.prepareRuntime,
      resolveRuntime: fixture.resolveRuntime,
      build,
      ensureWorkspaceBuild: async () => {},
    });
    expect(second.status).toBe('reused');
    expect(build).toHaveBeenCalledTimes(1);
    await expect(assertAppBuildFresh(fixture.root, { resolveRuntime: fixture.resolveRuntime })).resolves.toBeTruthy();
  });

  it('rebuilds after App or workspace source changes and detects output tampering', async () => {
    const fixture = await createFixture();
    const build = vi.fn(fixture.writeOutputs);
    await ensureAppBuild(fixture.root, {
      prepareRuntime: fixture.prepareRuntime,
      resolveRuntime: fixture.resolveRuntime,
      build,
      ensureWorkspaceBuild: async () => {},
    });

    await write(join(fixture.root, 'packages/alpha/src/index.ts'), 'export const name = "changed"\n');
    const staleInput = await inspectAppBuildFreshness(fixture.root, { resolveRuntime: fixture.resolveRuntime });
    expect(staleInput).toMatchObject({ fresh: false, reason: 'input-mismatch' });
    await ensureAppBuild(fixture.root, {
      prepareRuntime: fixture.prepareRuntime,
      resolveRuntime: fixture.resolveRuntime,
      build,
      ensureWorkspaceBuild: async () => {},
    });
    expect(build).toHaveBeenCalledTimes(2);

    await write(join(fixture.root, 'packages/app/out/main/index.js'), 'tampered');
    await expect(assertAppBuildFresh(fixture.root, { resolveRuntime: fixture.resolveRuntime }))
      .rejects.toThrow(/output-mismatch/);
  });

  it('does not leave a successful sidecar after build failure or an input race', async () => {
    const failed = await createFixture();
    await expect(ensureAppBuild(failed.root, {
      prepareRuntime: failed.prepareRuntime,
      resolveRuntime: failed.resolveRuntime,
      build: async () => { throw new Error('fixture build failed'); },
      ensureWorkspaceBuild: async () => {},
    })).rejects.toThrow('fixture build failed');
    await expect(readFile(appBuildManifestPath(failed.root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const raced = await createFixture();
    await expect(ensureAppBuild(raced.root, {
      prepareRuntime: raced.prepareRuntime,
      resolveRuntime: raced.resolveRuntime,
      build: async () => {
        await raced.writeOutputs();
        await write(join(raced.root, 'packages/app/src/index.ts'), 'export const raced = true\n');
      },
      ensureWorkspaceBuild: async () => {},
    })).rejects.toThrow(/inputs changed while the build was running/);
    await expect(readFile(appBuildManifestPath(raced.root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects missing outputs, runtime mismatches, and output symlinks', async () => {
    const fixture = await createFixture();
    await fixture.writeOutputs();
    await rm(join(fixture.root, 'packages/app/out/preload/index.js'));
    await expect(fingerprintAppBuildOutputs(fixture.root)).rejects.toThrow(/preload\/index\.js/);

    await write(join(fixture.root, 'packages/app/out/preload/index.js'), 'preload-output');
    await write(fixture.runtimePath, 'different-electron-binary');
    await expect(fixture.resolveRuntime(fixture.root, fixture.runtimePath)).rejects.toThrow(/does not match/);

    await write(fixture.runtimePath, 'electron-binary');
    const outside = join(fixture.root, 'outside.js');
    await write(outside, 'outside');
    const linked = join(fixture.root, 'packages/app/out/renderer/assets/linked.js');
    try {
      await symlink(outside, linked, 'file');
    } catch (error) {
      if (error && typeof error === 'object' && ['EPERM', 'EACCES'].includes(error.code)) return;
      throw error;
    }
    await expect(fingerprintAppBuildOutputs(fixture.root)).rejects.toThrow(/symbolic link/);
  });

  it('rejects prepared runtime entries with the wrong filesystem type', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.root, 'packages/app/runtime', `electron-v1.2.3-${process.platform}-${process.arch}`, 'locales'), {
      recursive: true,
      force: true,
    });
    await write(
      join(fixture.root, 'packages/app/runtime', `electron-v1.2.3-${process.platform}-${process.arch}`, 'locales'),
      'not-a-directory',
    );
    await expect(fixture.resolveRuntime(fixture.root, fixture.runtimePath)).rejects.toThrow(/not a directory/);
  });
});
