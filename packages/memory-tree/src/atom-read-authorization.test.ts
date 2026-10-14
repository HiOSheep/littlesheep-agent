import { describe, expect, it } from 'vitest';
import type { MemoryAccessPolicy, MemoryAccessTarget } from '@littlesheep/types';
import { assertAtomReadAuthorization, createAtomReadAuthorization } from './atom-read-authorization.js';
import { InMemoryOwnershipBindings } from './memory-ownership-bindings.js';
import { bindMemoryAccessGrant, issueMemoryAccessGrant, inspectMemoryAccessContext, issueChildMemoryAccessGrant } from './memory-access-context.js';

const base: MemoryAccessPolicy = { version: 1, revision: 0, principalId: 'local:root', dataRootId: 'root', sessionId: 's', runId: 'r',
  projectId: 'p', readMode: 'project', writeMode: 'disabled', selected: [], disabled: [], globalWriteGranted: false };
const target: MemoryAccessTarget = { kind: 'atom', id: 'a', principalId: 'local:root', dataRootId: 'root', binding: 'reviewed', scope: 'project', projectId: 'p' };

describe('sealed Atom authorization matrix', () => {
  it('rejects caller-created allow gates and JSON copies', () => {
    expect(() => assertAtomReadAuthorization({ assertCurrent: async () => {}, references: async () => ['a'], allows: async () => true })).toThrow('unavailable');
    expect(() => assertAtomReadAuthorization(JSON.parse('{}'))).toThrow('unavailable');
  });
  it.each([
    ['same project', {}, {}, true], ['none', { readMode: 'none' }, {}, false],
    ['cross project', {}, { projectId: 'other' }, false], ['global not opted in', {}, { scope: 'global', projectId: undefined }, false],
    ['explicit global', { readMode: 'global' }, { scope: 'global', projectId: undefined }, true],
    ['manual selected', { readMode: 'manual', selected: [{ kind: 'atom', id: 'a' }] }, {}, true],
    ['manual cross project', { readMode: 'manual', selected: [{ kind: 'atom', id: 'a' }] }, { projectId: 'other' }, false],
    ['disabled', { disabled: [{ kind: 'atom', id: 'a' }] }, {}, false], ['pending', {}, { binding: 'pending' }, false],
    ['different owner', {}, { principalId: 'other' }, false], ['different root', {}, { dataRootId: 'other' }, false],
  ])('%s', async (_label, patch, targetPatch, allowed) => {
    const store = new InMemoryOwnershipBindings();
    store.compareAndSet({ version: 1, revision: 0, entityRevision: 'v3:1', target: { ...target, ...targetPatch } as MemoryAccessTarget }, undefined);
    const context = await bindMemoryAccessGrant(issueMemoryAccessGrant({ rootId: 'root', runId: 'r', sessionId: 's', workspace: 'w', current: async () => true,
      resolve: async () => ({ source: 'host', enforcement: 'enforced', projectIdentityVersion: 2, projectBindingRevision: 'binding', policy: { ...base, ...patch } as MemoryAccessPolicy }) }),
      { runId: 'r', sessionId: 's', workspace: 'w' }, 'root');
    const gate = createAtomReadAuthorization(context, store);
    expect(await gate.allows('a', 'v3:1')).toBe(allowed);
    expect(await gate.allows('a', 'v3:2')).toBe(false);
    expect(await gate.allows('unknown')).toBe(false);
    expect(await gate.references()).toEqual(allowed ? ['a'] : []);
  });
  it('inherits enforced mode and rechecks revoked bindings and runtime authority without a cache', async () => {
    let current = true;
    const store = new InMemoryOwnershipBindings();
    store.compareAndSet({ version: 1, revision: 0, entityRevision: 'v3:1', target }, undefined);
    const parent = await bindMemoryAccessGrant(issueMemoryAccessGrant({ rootId: 'root', runId: 'r', sessionId: 's', workspace: 'w', current: async () => current,
      resolve: async () => ({ source: 'host', enforcement: 'enforced', projectIdentityVersion: 2, projectBindingRevision: 'binding', policy: base }) }),
      { runId: 'r', sessionId: 's', workspace: 'w' }, 'root');
    const child = await bindMemoryAccessGrant(issueChildMemoryAccessGrant(parent, 'child', 'w'), { runId: 'child', sessionId: 's', workspace: 'w' }, 'root');
    expect(inspectMemoryAccessContext(child, { runId: 'child', sessionId: 's', rootId: 'root' }).enforcement).toBe('enforced');
    const gate = createAtomReadAuthorization(child, store);
    expect(await gate.allows('a', 'v3:1')).toBe(true);
    store.compareAndSet({ version: 1, revision: 1, entityRevision: 'v3:1', target: { ...target, binding: 'pending' } }, 0);
    expect(await gate.allows('a', 'v3:1')).toBe(false);
    current = false;
    await expect(gate.references()).rejects.toThrow('authorization unavailable');
  });
});
