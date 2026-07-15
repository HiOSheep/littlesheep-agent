// Owns migration workspace paths, ownership checks, and bounded filesystem operations.

import { mkdir, readFile, rm, stat, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { durableAtomicWriteJson } from '../v3/durable-json.js';
import type { MemoryV3MigrationFaultContext } from './v3-migration-contracts.js';

const MIGRATION_OWNER_FILE = 'owner.json';

export interface MemoryV3MigrationPaths extends MemoryV3MigrationFaultContext {
  snapshotDir: string;
  stageV3Dir: string;
}

export function memoryV3MigrationPaths(dataDir: string, migrationId: string): MemoryV3MigrationPaths {
  const migrationDir = join(dataDir, 'memory-tree', 'migrations', migrationId);
  const stageDataDir = join(migrationDir, 'stage-data');
  return {
    migrationId,
    dataDir,
    migrationDir,
    snapshotDir: join(migrationDir, 'snapshot'),
    stageDataDir,
    stageV3Dir: join(stageDataDir, 'memory-tree', 'v3'),
    activeV3Dir: join(dataDir, 'memory-tree', 'v3'),
    inactiveV3Dir: join(migrationDir, 'previous-v3'),
    abandonedV3Dir: join(migrationDir, 'abandoned-v3'),
  };
}

export async function ensureMigrationOwnership(
  migrationDir: string,
  migrationId: string,
  createdAt: string,
): Promise<void> {
  await mkdir(migrationDir, { recursive: true });
  const ownerPath = join(migrationDir, MIGRATION_OWNER_FILE);
  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { version?: unknown; kind?: unknown; id?: unknown };
    if (owner.version !== 1 || owner.kind !== 'memory-v2-to-v3' || owner.id !== migrationId) {
      throw new Error('Memory migration directory ownership marker is invalid.');
    }
  } catch (error) {
    if (migrationErrorCode(error) !== 'ENOENT') throw error;
    await durableAtomicWriteJson(ownerPath, { version: 1, kind: 'memory-v2-to-v3', id: migrationId, createdAt });
  }
}

export async function removeOwnedMigrationChild(paths: MemoryV3MigrationPaths, target: string): Promise<void> {
  const root = resolve(paths.migrationDir);
  const resolved = resolve(target);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error('Refusing to remove a path outside the owned migration directory.');
  await ensureMigrationOwnership(paths.migrationDir, paths.migrationId, new Date().toISOString());
  await rm(resolved, { recursive: true, force: true });
}

export async function migrationDirectoryExists(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), (error: unknown) => {
    if (migrationErrorCode(error) === 'ENOENT') return false;
    throw error;
  });
}

export async function availableFilesystemBytes(path: string): Promise<number> {
  try {
    const info = await statfs(path);
    return Math.max(0, Number(info.bavail) * Number(info.bsize));
  } catch (error) {
    if (['ENOSYS', 'ENOTSUP', 'EINVAL'].includes(migrationErrorCode(error) ?? '')) return Number.POSITIVE_INFINITY;
    throw error;
  }
}

export function migrationErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
