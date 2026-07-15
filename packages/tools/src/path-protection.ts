import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolContext } from '@littlesheep/types';

export const CORE_SOURCE_READ_ONLY_ERROR = 'LittleSheep core source is read-only in this version';

export function resolveToolPath(path: string, cwd: string): string {
  return resolve(cwd, path);
}

export function findProtectedWriteRoot(path: string, ctx: ToolContext): string | undefined {
  const candidate = canonicalPath(resolveToolPath(path, ctx.cwd));
  for (const root of ctx.protectedWriteRoots ?? []) {
    const protectedRoot = canonicalPath(root);
    if (isPathInsideOrSame(protectedRoot, candidate)) return protectedRoot;
  }
  return undefined;
}

export function commandReferencesProtectedRoot(command: string, roots: readonly string[] = []): string | undefined {
  const normalizedCommand = normalizeForComparison(command).replaceAll('\\', '/');
  for (const root of roots) {
    const normalizedRoot = normalizeForComparison(resolve(root)).replaceAll('\\', '/');
    if (normalizedRoot && normalizedCommand.includes(normalizedRoot)) return canonicalPath(root);
  }
  return undefined;
}

export function isReadOnlyCoreCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || /[\r\n;&|><`()]/u.test(trimmed) || trimmed.includes('$(')) return false;
  if (/(?:--output|--pre|--ext-diff|--textconv|--open-files-in-pager)(?:=|\s|$)/iu.test(trimmed)) return false;

  return [
    /^(?:rg|grep|cat|head|tail|wc)(?:\s|$)/iu,
    /^(?:Get-ChildItem|Get-Content|Get-Location|Select-String)(?:\s|$)/iu,
    /^(?:dir|ls|pwd|type|where(?:\.exe)?)(?:\s|$)/iu,
    /^node\s+--version\s*$/iu,
    /^(?:npm|pnpm)\s+--version\s*$/iu,
    /^git\s+(?:status|log|diff|show|grep|ls-files|rev-parse|blame)(?:\s|$)/iu,
    /^git\s+(?:branch|tag)(?:\s+(?:--list|--show-current))?\s*$/iu,
    /^git\s+remote\s+-v\s*$/iu,
  ].some((pattern) => pattern.test(trimmed));
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missingSegments: string[] = [];
  let cursor = absolute;

  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }

  try {
    return resolve(realpathSync.native(cursor), ...missingSegments);
  } catch {
    return absolute;
  }
}

function isPathInsideOrSame(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForComparison(root);
  const normalizedCandidate = normalizeForComparison(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function normalizeForComparison(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}
