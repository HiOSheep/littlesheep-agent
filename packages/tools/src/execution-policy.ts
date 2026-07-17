import { resolve } from 'node:path';
import type { ToolExecutionPolicy } from '@littlesheep/types';

export function parallelFilePolicy(
  field: string,
  mode: 'read' | 'write',
  fallbackToCwd = false,
): ToolExecutionPolicy {
  return {
    concurrency: 'parallel',
    resources(input, ctx) {
      const raw = input && typeof input === 'object'
        ? (input as Record<string, unknown>)[field]
        : undefined;
      const path = typeof raw === 'string' && raw.trim()
        ? resolve(ctx.cwd, raw.trim())
        : fallbackToCwd
          ? resolve(ctx.cwd)
          : undefined;
      return path ? [{ key: `fs:${normalizeResourcePath(path)}`, mode }] : [];
    },
  };
}

function normalizeResourcePath(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}
