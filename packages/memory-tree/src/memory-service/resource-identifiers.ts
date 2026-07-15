import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { MemoryResourceKind, MemoryResourceOwnerKind } from '../types.js';

export function attachmentManifestResourceId(runId: string): string {
  return `attachment-manifest:${runId}`;
}

export function attachmentResourceId(runId: string, attachmentId: string): string {
  return `attachment:${runId}:${attachmentId}`;
}

export function runtimeEventLedgerResourceId(runId: string): string {
  return `runtime-events:${runId}`;
}

export function hashId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

export function normalizedPath(value: string): string {
  return resolve(value).replace(/[\\/]+/g, '/').replace(/\/$/u, '').toLocaleLowerCase();
}

export function fileResourceId(path: string): string {
  return `file:${hashId(normalizedPath(path))}`;
}

export function contentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function documentKind(fileName: string): MemoryResourceKind {
  const lower = fileName.toLocaleLowerCase();
  if (lower.includes('ui') && /(guideline|规范)/u.test(lower)) return 'ui-guideline';
  if (/(taskbook|任务书)/u.test(lower)) return 'taskbook';
  if (/(principle|guideline|architecture|规范|原则)/u.test(lower)) return 'project-guideline';
  return 'knowledge';
}

export function isWorkspaceDocument(fileName: string): boolean {
  const lower = fileName.toLocaleLowerCase();
  return lower === 'readme.md'
    || /(taskbook|guideline|principle|architecture|任务书|规范|原则)/u.test(lower);
}

export function workspaceDocumentRegistryGroup(root: string): string {
  return `workspace-docs:${hashId(normalizedPath(root))}`;
}

export function workspaceIndexRegistryGroup(identity: string): string {
  return `workspace-index:${hashId(identity)}`;
}

export function skillRegistryGroup(kind: MemoryResourceOwnerKind, ownerId: string): string {
  return kind === 'plugin'
    ? `skills:plugin:${ownerId}`
    : `skills:${kind}:${hashId(ownerId)}`;
}

export function skillOwnerKey(kind: MemoryResourceOwnerKind, ownerId: string, skillName: string): string {
  return `${kind}:${ownerId}:${skillName}`.toLocaleLowerCase();
}

export function pathInsideOrSame(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function workspaceDisplayTitle(root: string, path: string): string {
  const relativeTitle = relative(root, path).replace(/[\\/]+/g, '/');
  return relativeTitle.split('/').length <= 2 ? basename(path) : relativeTitle;
}
