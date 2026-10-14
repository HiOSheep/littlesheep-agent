// Host-issued process-local capabilities. P1B-1 propagates authority, not retrieval enforcement.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { MemoryAccessPolicy, MemoryAccessTarget } from '@littlesheep/types';
import { evaluateMemoryRead, evaluateMemoryWrite, intersectMemoryAccessDecisions, isMemoryAccessPolicy } from './memory-access-policy.js';

declare const grantBrand: unique symbol;
declare const contextBrand: unique symbol;
export interface MemoryAccessGrant { readonly [grantBrand]: true }
export interface MemoryAccessContext { readonly [contextBrand]: true }
export interface MemoryAccessBinding { runId: string; sessionId: string; workspace: string }
export interface MemoryAccessSnapshot {
  policy: MemoryAccessPolicy;
  enforcement: 'propagation-only';
  source: 'host' | 'standalone-adapter';
  projectIdentityVersion?: number;
  /** Fingerprint of the verified current registry binding, separate from entity revision. */
  projectBindingRevision?: string;
  ancestors: readonly MemoryAccessPolicy[];
}
interface ContextRecord {
  active: boolean;
  workspace: string;
  snapshot: MemoryAccessSnapshot;
  current: () => Promise<boolean>;
}
interface GrantRecord {
  rootId: string;
  runId: string;
  sessionId?: string;
  workspace: string;
  resolve: (binding: MemoryAccessBinding) => Promise<Omit<MemoryAccessSnapshot, 'ancestors' | 'enforcement'>>;
  current: () => Promise<boolean>;
  parent?: MemoryAccessContext;
  consumed: boolean;
}
const grants = new WeakMap<object, GrantRecord>();
const contexts = new WeakMap<object, ContextRecord>();

export class MemoryAccessAuthorizationError extends Error {
  constructor(message: string) { super(message); this.name = 'MemoryAccessAuthorizationError'; }
}

/** Canonical local root identity. Moving a root requires fresh authorization; no sidecar proof. */
export function memoryAccessRootId(root: string): string {
  const canonical = realpathSync(root);
  return `root:${createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex')}`;
}

/** Trusted Host API; never expose this constructor through JSON/tool/Renderer protocols. */
export function issueMemoryAccessGrant(input: Omit<GrantRecord, 'consumed'>): MemoryAccessGrant {
  if (!input.runId || !input.workspace || (input.parent && !contexts.has(input.parent))) throw new Error('Invalid memory grant identity');
  const grant = Object.freeze({});
  grants.set(grant, { ...input, consumed: false });
  return grant as MemoryAccessGrant;
}

export async function bindMemoryAccessGrant(grant: MemoryAccessGrant, binding: MemoryAccessBinding, rootId: string): Promise<MemoryAccessContext> {
  const record = grant && grants.get(grant);
  if (!record || record.consumed || record.rootId !== rootId || record.runId !== binding.runId
    || (record.sessionId !== undefined && record.sessionId !== binding.sessionId)
    || record.workspace !== binding.workspace) throw new Error('Untrusted or stale memory access grant');
  record.consumed = true;
  if (!await record.current()) throw new Error('Stale memory access grant');
  const resolved = await record.resolve(binding);
  const p = resolved.policy;
  if (!isMemoryAccessPolicy(p) || p.dataRootId !== rootId || p.principalId !== `local:${rootId}`
    || p.runId !== binding.runId || p.sessionId !== binding.sessionId
    || !['host', 'standalone-adapter'].includes(resolved.source)
    || (p.readMode === 'project' && !p.projectId)
    || (p.projectId && (![1, 2].includes(resolved.projectIdentityVersion ?? 0)
      || typeof resolved.projectBindingRevision !== 'string' || !resolved.projectBindingRevision
      || resolved.projectBindingRevision.length > 512))) throw new Error('Invalid memory access policy binding');
  const parent = record.parent && contexts.get(record.parent);
  if (parent && (!parent.active || !await parent.current() || parent.snapshot.policy.sessionId !== p.sessionId
    || parent.snapshot.policy.projectId !== p.projectId || parent.snapshot.policy.dataRootId !== rootId)) throw new Error('Invalid memory access ancestor');
  // The asynchronous resolver can outlive a registry/settings revision.
  if (!await record.current()) throw new Error('Stale memory access grant');
  const minimizedPolicy: MemoryAccessPolicy = { version: p.version, revision: p.revision,
    principalId: p.principalId, dataRootId: p.dataRootId, sessionId: p.sessionId, runId: p.runId,
    projectId: p.projectId, readMode: p.readMode, writeMode: p.writeMode,
    selected: p.selected.map(({ kind, id }) => ({ kind, id })), disabled: p.disabled.map(({ kind, id }) => ({ kind, id })),
    globalWriteGranted: p.globalWriteGranted };
  const snapshot = structuredClone({ source: resolved.source, policy: minimizedPolicy,
    projectIdentityVersion: resolved.projectIdentityVersion, projectBindingRevision: resolved.projectBindingRevision,
    enforcement: 'propagation-only' as const,
    ancestors: parent ? [...parent.snapshot.ancestors, parent.snapshot.policy] : [] });
  const context = Object.freeze({});
  contexts.set(context, { active: true, workspace: record.workspace, snapshot, current: async () => await record.current() && (!parent || (parent.active && await parent.current())) });
  return context as MemoryAccessContext;
}

export function inspectMemoryAccessContext(context: MemoryAccessContext, binding: { runId: string; sessionId: string; rootId: string; workspace?: string }): MemoryAccessSnapshot {
  const record = context && contexts.get(context);
  if (!record || record.snapshot.policy.runId !== binding.runId || record.snapshot.policy.sessionId !== binding.sessionId
    || record.snapshot.policy.dataRootId !== binding.rootId
    || (binding.workspace !== undefined && record.workspace !== binding.workspace)) throw new MemoryAccessAuthorizationError('Untrusted memory access context');
  return structuredClone(record.snapshot);
}

export async function memoryAccessContextIsCurrent(context: MemoryAccessContext): Promise<boolean> {
  const record = context && contexts.get(context);
  if (!record || !record.active) return false;
  try { return await record.current(); } catch { return false; }
}

export function closeMemoryAccessContext(context: MemoryAccessContext): void {
  const record = contexts.get(context);
  if (record) record.active = false;
}

/** Child-only Host port: there is no optional ancestor field and no policy upgrade input. */
export function issueChildMemoryAccessGrant(parent: MemoryAccessContext, runId: string, workspace: string): MemoryAccessGrant {
  const record = parent && contexts.get(parent);
  if (!record || !record.active || workspace !== record.workspace) throw new Error('Invalid memory child binding');
  const p = record.snapshot.policy;
  return issueMemoryAccessGrant({ rootId: p.dataRootId, runId, sessionId: p.sessionId, workspace, parent,
    current: () => memoryAccessContextIsCurrent(parent), resolve: async () => ({
      source: record.snapshot.source, projectIdentityVersion: record.snapshot.projectIdentityVersion,
      projectBindingRevision: record.snapshot.projectBindingRevision, policy: { ...p, runId },
    }) });
}

/** Future read/write gates must use the full sealed chain, never a caller-supplied ancestor list. */
export async function evaluateMemoryAccessContext(context: MemoryAccessContext, target: MemoryAccessTarget, action: 'read' | 'write') {
  const record = context && contexts.get(context);
  if (!record || !await memoryAccessContextIsCurrent(context)) return { outcome: 'deny' as const, reason: 'invalid-policy' as const };
  const evaluate = action === 'read' ? evaluateMemoryRead : evaluateMemoryWrite;
  return intersectMemoryAccessDecisions([...record.snapshot.ancestors, record.snapshot.policy].map((p) => evaluate(p, target)));
}

/** Restricted compatibility adapter: self-declared cwd/project fields grant no project/global access. */
export function issueStandaloneMemoryAccessGrant(rootId: string, binding: MemoryAccessBinding): MemoryAccessGrant {
  return issueMemoryAccessGrant({ rootId, ...binding, current: async () => true,
    resolve: async () => ({ source: 'standalone-adapter', policy: {
      version: 1, revision: 0, principalId: `local:${rootId}`, dataRootId: rootId,
      sessionId: binding.sessionId, runId: binding.runId, readMode: 'none', writeMode: 'disabled',
      selected: [], disabled: [], globalWriteGranted: false,
    } }) });
}
