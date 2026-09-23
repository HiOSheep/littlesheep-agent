import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolContext } from '@littlesheep/types';

export const CORE_SOURCE_READ_ONLY_ERROR = 'LittleSheep core source is read-only in this version';

/**
 * The bounded `meta.errorKind` every protected-root refusal declares.
 *
 * The main loop classifies tool failures from the Runtime's own records rather
 * than from error text, so a refusal that has to stop the run must name itself.
 * Without this, a returned failure inside a protected root looks like an
 * ordinary execution error and the model is allowed to keep probing the same
 * boundary with other tools.
 */
export const CORE_SOURCE_READ_ONLY_KIND = 'core_source_read_only';

/**
 * The one wording every protected-root refusal uses, including what still works.
 *
 * A bare "denied" tells the model nothing it can act on: in the recorded failure
 * it retried variations of the same command instead of switching to a form the
 * Runtime can prove read-only. Naming the allowed shapes and the structured
 * read-only tools turns the refusal into a next step, and saying that approval
 * cannot lift it stops the model from asking the user for something the host
 * boundary will refuse anyway.
 */
export function coreSourceReadOnlyMessage(target: string): string {
  return [
    `${CORE_SOURCE_READ_ONLY_ERROR}: ${target}.`,
    'Approval cannot override this host-level protection.',
    'Read-only inspection still works here: `Get-ChildItem <path>` or `dir <path>` to list a directory,',
    '`Test-Path -LiteralPath <path>` to test existence, `Get-Content <path>` / `rg <pattern> <path>` to read.',
    'The `glob`, `grep` and `read` tools reach the same files without a shell.',
    'Compound commands (`;`, `&&`, `|`, redirection) and writers (`mkdir`, `Set-Content`, `Remove-Item`) stay refused.',
    'Write into a writable workspace instead of this root.',
  ].join(' ');
}

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
  // `Test-Path -Credential` can prompt for or use stored credentials, which is an
  // authentication side channel rather than a read-only local probe.
  if (/(?:^|\s)-Credential(?:\s|$)/iu.test(trimmed)) return false;

  return [
    /^(?:rg|grep|cat|head|tail|wc)(?:\s|$)/iu,
    /^(?:Get-ChildItem|Get-Content|Get-Location|Select-String)(?:\s|$)/iu,
    // Existence is the one probe with no structured equivalent for an arbitrary
    // path, and a single `Test-Path` cannot write anything. The guards above are
    // what keep this narrow: no separators, no redirection, no subexpressions.
    /^Test-Path(?:\s|$)/iu,
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
