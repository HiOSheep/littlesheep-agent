import { isAbsolute, relative, resolve } from 'node:path';

export function normalizedFilePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/u, '');
}

export function sameFilePath(left: string, right: string): boolean {
  return normalizedFilePath(left).toLocaleLowerCase() === normalizedFilePath(right).toLocaleLowerCase();
}

export function pathInsideOrSame(root: string, path: string): boolean {
  const rel = relative(normalizedFilePath(root), normalizedFilePath(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function rebaseFilePath(path: string, fromRoot: string, toRoot: string): string {
  const normalized = normalizedFilePath(path);
  if (!pathInsideOrSame(fromRoot, normalized)) return normalized;
  const rel = relative(normalizedFilePath(fromRoot), normalized);
  return rel ? resolve(normalizedFilePath(toRoot), rel) : normalizedFilePath(toRoot);
}
