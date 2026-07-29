import type { ToolResourceAccess } from '@littlesheep/types';

export interface ScheduledToolExecution<T> {
  index: number;
  concurrency: 'parallel' | 'exclusive';
  resources: readonly ToolResourceAccess[];
  execute: () => Promise<T>;
}

export function buildToolExecutionWaves<T>(
  calls: readonly ScheduledToolExecution<T>[],
  maxParallel: number,
): ScheduledToolExecution<T>[][] {
  const limit = Math.max(1, Math.min(8, Math.trunc(maxParallel) || 1));
  const waves: ScheduledToolExecution<T>[][] = [];

  for (const call of calls) {
    if (call.concurrency === 'exclusive') {
      waves.push([call]);
      continue;
    }
    const wave = waves.at(-1);
    if (wave
      && wave.length < limit
      && wave.every((candidate) => candidate.concurrency === 'parallel')
      && wave.every((candidate) => !toolResourcesConflict(candidate.resources, call.resources))) {
      wave.push(call);
    } else {
      waves.push([call]);
    }
  }
  return waves;
}

export async function executeToolWaves<T>(
  calls: readonly ScheduledToolExecution<T>[],
  maxParallel: number,
): Promise<Map<number, T>> {
  const results = new Map<number, T>();
  for (const wave of buildToolExecutionWaves(calls, maxParallel)) {
    const completed = await Promise.all(wave.map(async (call) => ({
      index: call.index,
      result: await call.execute(),
    })));
    for (const item of completed) results.set(item.index, item.result);
  }
  return results;
}

export function toolResourcesConflict(
  left: readonly ToolResourceAccess[],
  right: readonly ToolResourceAccess[],
): boolean {
  for (const first of left) {
    for (const second of right) {
      if (!resourceKeysOverlap(first.key, second.key)) continue;
      if (first.mode === 'write' || second.mode === 'write') return true;
    }
  }
  return false;
}

/** True when one declared envelope entry safely contains an actual access. */
export function toolResourceAccessCovered(
  declared: ToolResourceAccess,
  actual: ToolResourceAccess,
): boolean {
  if (actual.mode === 'write' && declared.mode !== 'write') return false;
  return resourceKeyContains(declared.key, actual.key);
}

function resourceKeysOverlap(left: string, right: string): boolean {
  return resourceKeyContains(left, right) || resourceKeyContains(right, left);
}

function resourceKeyContains(parent: string, child: string): boolean {
  const normalizedParent = normalizeResourceKey(parent);
  const normalizedChild = normalizeResourceKey(child);
  if (normalizedParent === normalizedChild) return true;
  if (!normalizedParent.startsWith('fs:') || !normalizedChild.startsWith('fs:')) return false;
  return normalizedChild.startsWith(`${normalizedParent}/`);
}

function normalizeResourceKey(value: string): string {
  const trimmed = value.trim().replace(/\\/gu, '/').replace(/\/+$/u, '');
  return process.platform === 'win32' && trimmed.startsWith('fs:')
    ? trimmed.toLocaleLowerCase()
    : trimmed;
}
