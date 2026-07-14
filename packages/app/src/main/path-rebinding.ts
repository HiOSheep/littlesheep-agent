import { isAbsolute, relative, resolve } from 'node:path'

export function normalizeBoundPath(path: string): string {
  return resolve(path).replace(/[\\/]+$/u, '')
}

export function sameBoundPath(left: string, right: string): boolean {
  return normalizeBoundPath(left).toLocaleLowerCase() === normalizeBoundPath(right).toLocaleLowerCase()
}

export function isPathInsideOrSameBound(root: string, candidate: string): boolean {
  const rel = relative(normalizeBoundPath(root), normalizeBoundPath(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function rebaseBoundPath(path: string, fromRoot: string, toRoot: string): string {
  const normalizedPath = normalizeBoundPath(path)
  const normalizedFrom = normalizeBoundPath(fromRoot)
  const normalizedTo = normalizeBoundPath(toRoot)
  if (!isPathInsideOrSameBound(normalizedFrom, normalizedPath)) return normalizedPath
  const rel = relative(normalizedFrom, normalizedPath)
  return rel ? resolve(normalizedTo, rel) : normalizedTo
}

export function appendBoundPathHistory(paths: string[] | undefined, path: string, limit = 8): string[] {
  const normalized = normalizeBoundPath(path)
  const next = [normalized, ...(paths ?? []).map(normalizeBoundPath)]
  return next.filter((entry, index) => (
    next.findIndex((candidate) => sameBoundPath(candidate, entry)) === index
  )).slice(0, Math.max(1, limit))
}
