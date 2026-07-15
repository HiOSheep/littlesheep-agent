import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MAX_WALK_UP = 12;

export function discoverLittleSheepCoreRoots(starts: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const start of starts) {
    if (!start) continue;
    const root = findLittleSheepWorkspaceRoot(start);
    if (root) roots.add(root);
  }
  return [...roots];
}

export function findLittleSheepWorkspaceRoot(start: string): string | undefined {
  let current = startingDirectory(start);
  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    if (isLittleSheepWorkspaceRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function startingDirectory(start: string): string {
  const absolute = resolve(start);
  try {
    return statSync(absolute).isDirectory() ? absolute : dirname(absolute);
  } catch {
    return dirname(absolute);
  }
}

function isLittleSheepWorkspaceRoot(path: string): boolean {
  const packagePath = join(path, 'package.json');
  if (!existsSync(join(path, 'pnpm-workspace.yaml')) || !existsSync(packagePath)) return false;
  if (!existsSync(join(path, 'packages', 'runner', 'package.json'))) return false;
  if (!existsSync(join(path, 'packages', 'harness', 'package.json'))) return false;
  if (!existsSync(join(path, 'packages', 'app', 'package.json'))) return false;

  try {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown };
    return manifest.name === 'littlesheep';
  } catch {
    return false;
  }
}
