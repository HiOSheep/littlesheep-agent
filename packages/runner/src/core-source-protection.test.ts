import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverLittleSheepCoreRoots, findLittleSheepWorkspaceRoot } from './core-source-protection.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LittleSheep core source discovery', () => {
  it('finds a workspace root from a nested package path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-core-root-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'packages', 'runner'), { recursive: true });
    await mkdir(join(root, 'packages', 'harness'), { recursive: true });
    await mkdir(join(root, 'packages', 'app'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'littlesheep' }), 'utf8');
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []', 'utf8');
    await Promise.all(['runner', 'harness', 'app'].map((name) => (
      writeFile(join(root, 'packages', name, 'package.json'), JSON.stringify({ name }), 'utf8')
    )));

    expect(findLittleSheepWorkspaceRoot(join(root, 'packages', 'app'))).toBe(root);
    expect(discoverLittleSheepCoreRoots([join(root, 'packages', 'runner'), root])).toEqual([root]);
  });

  it('does not protect unrelated workspaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-unrelated-root-'));
    temporaryRoots.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'other' }), 'utf8');
    expect(findLittleSheepWorkspaceRoot(root)).toBeUndefined();
  });
});
