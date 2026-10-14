import { describe, expect, it } from 'vitest';
import type { MemoryAccessPolicy } from '@littlesheep/types';
import { bindMemoryAccessGrant, evaluateMemoryAccessContext, inspectMemoryAccessContext,
  issueMemoryAccessGrant, issueStandaloneMemoryAccessGrant, issueChildMemoryAccessGrant, closeMemoryAccessContext,
  memoryAccessContextIsCurrent, type MemoryAccessGrant } from './memory-access-context.js';
import { InMemoryOwnershipBindings } from './memory-ownership-bindings.js';
const binding = { runId: 'run-a', sessionId: 'session-a', workspace: 'workspace-a' };
const policy: MemoryAccessPolicy = { version: 1, revision: 0, principalId: 'local:root-a', dataRootId: 'root-a',
  ...binding, readMode: 'global', writeMode: 'ask', selected: [], disabled: [], globalWriteGranted: false };
const mint = (patch: Partial<MemoryAccessPolicy> = {}, current = async () => true) => issueMemoryAccessGrant({
  rootId: 'root-a', ...binding, current, resolve: async () => ({ source: 'host', policy: { ...policy, ...patch } }),
});
describe('process-local memory authority', () => {
  it('rejects a changed authorization during asynchronous policy resolution', async () => {
    let current = true;
    const grant = issueMemoryAccessGrant({ rootId: 'root-a', ...binding, current: async () => current,
      resolve: async () => { current = false; return { source: 'host', policy }; } });
    await expect(bindMemoryAccessGrant(grant, binding, 'root-a')).rejects.toThrow('Stale');
    await expect(bindMemoryAccessGrant(grant, binding, 'root-a')).rejects.toThrow('Untrusted');
  });
  it('rejects using a valid context in a different execution workspace', async () => {
    const context = await bindMemoryAccessGrant(mint(), binding, 'root-a');
    expect(() => inspectMemoryAccessContext(context, { ...binding, workspace: 'other', rootId: 'root-a' })).toThrow('Untrusted');
    expect(inspectMemoryAccessContext(context, { ...binding, rootId: 'root-a' }).policy.runId).toBe(binding.runId);
  });
  it('rejects JSON copies, self-declared grants, root/run/session/workspace mismatches and reuse', async () => {
    for (const fake of [{}, { policy }, null, JSON.parse(JSON.stringify(mint()))]) {
      await expect(bindMemoryAccessGrant(fake as MemoryAccessGrant, binding, 'root-a')).rejects.toThrow();
    }
    for (const patch of [{ runId: 'other' }, { sessionId: 'other' }, { workspace: 'other' }]) {
      await expect(bindMemoryAccessGrant(mint(), { ...binding, ...patch }, 'root-a')).rejects.toThrow();
    }
    await expect(bindMemoryAccessGrant(mint(), binding, 'other-root')).rejects.toThrow();
    const grant = mint(); await bindMemoryAccessGrant(grant, binding, 'root-a');
    await expect(bindMemoryAccessGrant(grant, binding, 'root-a')).rejects.toThrow();
    const concurrent = mint();
    const outcomes = await Promise.allSettled([bindMemoryAccessGrant(concurrent, binding, 'root-a'), bindMemoryAccessGrant(concurrent, binding, 'root-a')]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });
  it.each([{ version: 2 }, { revision: -1 }, { revision: NaN }, { projectId: 'unverified' }, { readMode: 'project' }, { principalId: 'other' }])('rejects invalid policy %j', async (patch) => {
    await expect(bindMemoryAccessGrant(mint(patch as Partial<MemoryAccessPolicy>), binding, 'root-a')).rejects.toThrow();
  });
  it('clones projections and rejects stale contexts even after binding', async () => {
    let current = true;
    const context = await bindMemoryAccessGrant(mint({}, async () => current), binding, 'root-a');
    const projection = inspectMemoryAccessContext(context, { ...binding, rootId: 'root-a' });
    projection.policy.readMode = 'none';
    expect(projection.policy).not.toHaveProperty('workspace');
    expect(inspectMemoryAccessContext(context, { ...binding, rootId: 'root-a' }).policy.readMode).toBe('global');
    current = false;
    expect(await memoryAccessContextIsCurrent(context)).toBe(false);
    expect((await evaluateMemoryAccessContext(context, { kind: 'atom', id: 'a', principalId: policy.principalId,
      dataRootId: 'root-a', scope: 'global', binding: 'reviewed' }, 'read')).outcome).toBe('deny');
  });
  it('sealed child chain preserves parent denial; forged parent is refused', async () => {
    const parent = await bindMemoryAccessGrant(mint({ readMode: 'none' }), binding, 'root-a');
    const childBinding = { ...binding, runId: 'child-a' };
    const child = await bindMemoryAccessGrant(issueMemoryAccessGrant({ rootId: 'root-a', ...childBinding, parent,
      current: async () => true, resolve: async () => ({ source: 'host', policy: { ...policy, runId: childBinding.runId } }) }), childBinding, 'root-a');
    expect((await evaluateMemoryAccessContext(child, { kind: 'atom', id: 'a', principalId: policy.principalId,
      dataRootId: 'root-a', scope: 'global', binding: 'reviewed' }, 'read')).outcome).toBe('deny');
    expect(inspectMemoryAccessContext(child, { ...childBinding, rootId: 'root-a' }).ancestors).toHaveLength(1);
    const inherited = await bindMemoryAccessGrant(issueChildMemoryAccessGrant(parent, 'child-b', binding.workspace),
      { ...binding, runId: 'child-b' }, 'root-a');
    expect(inspectMemoryAccessContext(inherited, { ...binding, runId: 'child-b', rootId: 'root-a' }).policy.readMode).toBe('none');
    expect(() => issueChildMemoryAccessGrant(parent, 'child-c', 'different-workspace')).toThrow();
    closeMemoryAccessContext(parent);
    expect(await memoryAccessContextIsCurrent(child)).toBe(false);
    expect(await memoryAccessContextIsCurrent(inherited)).toBe(false);
    expect(() => issueMemoryAccessGrant({ rootId: 'root-a', ...childBinding, parent: {} as typeof parent,
      current: async () => true, resolve: async () => ({ source: 'host', policy }) })).toThrow();
  });
  it('standalone adapter grants neither global nor project access', async () => {
    const context = await bindMemoryAccessGrant(issueStandaloneMemoryAccessGrant('root-a', binding), binding, 'root-a');
    const snapshot = inspectMemoryAccessContext(context, { ...binding, rootId: 'root-a' });
    expect(snapshot.source).toBe('standalone-adapter');
    expect(snapshot.policy).toMatchObject({ readMode: 'none', writeMode: 'disabled' });
    expect(snapshot.policy.projectId).toBeUndefined();
  });
  it('ownership foundation keeps pending and uses atomic revision checks without overwriting on conflict', () => {
    const store = new InMemoryOwnershipBindings(1);
    const entry = { version: 1 as const, revision: 0, entityRevision: 'entity-1', target: {
      kind: 'atom' as const, id: 'legacy', principalId: policy.principalId, dataRootId: 'root-a', scope: 'global' as const, binding: 'pending' as const,
    } };
    store.compareAndSet(entry, undefined);
    store.compareAndSet(structuredClone(entry), undefined);
    expect(store.get(entry.target)?.revision).toBe(0);
    expect(() => store.compareAndSet({ ...entry, revision: 1 }, undefined)).toThrow();
    expect(store.get(entry.target)?.target.binding).toBe('pending');
    store.compareAndSet({ ...entry, revision: 1, entityRevision: 'entity-2' }, 0);
    store.compareAndSet({ ...entry, revision: 1, entityRevision: 'entity-2' }, 0);
    expect(store.get(entry.target)?.revision).toBe(1);
    expect(() => store.compareAndSet({ ...entry, revision: 2, target: { ...entry.target, dataRootId: 'other-root' } }, 1)).toThrow();
    expect(store.get(entry.target)?.target.dataRootId).toBe('root-a');
    expect(() => store.compareAndSet({ ...entry, target: { ...entry.target, id: 'overflow' } }, undefined)).toThrow();
    expect(() => store.compareAndSet({ ...entry, content: 'never store raw memory' } as typeof entry, 1)).toThrow('content');
  });
});
