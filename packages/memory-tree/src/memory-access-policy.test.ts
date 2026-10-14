import { describe, expect, it } from 'vitest';
import type { MemoryAccessPolicy, MemoryAccessTarget } from '@littlesheep/types';
import { defaultMemoryWriteScope, evaluateMemoryRead, evaluateMemoryWrite,
  intersectMemoryAccessDecisions, isMemoryAccessPolicy } from './memory-access-policy.js';

const policy = (patch: Partial<MemoryAccessPolicy> = {}): MemoryAccessPolicy => ({
  version: 1, revision: 0, principalId: 'user-a', dataRootId: 'root-a',
  sessionId: 'session-a', runId: 'run-a', readMode: 'none', writeMode: 'ask',
  selected: [], disabled: [], globalWriteGranted: false, ...patch,
});
const target = (patch: Partial<MemoryAccessTarget> = {}): MemoryAccessTarget => ({
  kind: 'atom', id: 'memory-a', principalId: 'user-a', dataRootId: 'root-a',
  binding: 'reviewed', scope: 'global', ...patch,
});

describe('CMv2 P1A memory policy foundation (not runtime enforcement)', () => {
  it.each(['atom', 'resource'] as const)('uses the same ownership and mode gates for %s', (kind) => {
    const global = target({ kind });
    const own = target({ kind, scope: 'project', projectId: 'project-a' });
    const foreign = target({ kind, scope: 'project', projectId: 'project-b' });
    const p = policy({ projectId: 'project-a', readMode: 'project' });
    expect(evaluateMemoryRead(policy(), global).outcome).toBe('deny');
    expect(evaluateMemoryRead(p, own).outcome).toBe('allow');
    expect(evaluateMemoryRead(p, global).outcome).toBe('deny');
    expect(evaluateMemoryRead(p, foreign).outcome).toBe('deny');
    expect(evaluateMemoryRead({ ...p, readMode: 'global' }, global).outcome).toBe('allow');
    expect(evaluateMemoryRead({ ...p, readMode: 'global' }, foreign).outcome).toBe('deny');
  });
  it('shares reviewed project memory across sessions, not private session memory', () => {
    const p = policy({ readMode: 'project', projectId: 'project-a', sessionId: 'session-b' });
    expect(evaluateMemoryRead(p, target({ scope: 'project', projectId: 'project-a' })).outcome).toBe('allow');
    expect(evaluateMemoryRead(p, target({ scope: 'session', sessionId: 'session-a' })).outcome).toBe('deny');
  });
  it('manual selection cannot override ownership, disabled, or pending binding', () => {
    const p = policy({ readMode: 'manual', selected: [{ kind: 'atom', id: 'memory-a' }] });
    expect(evaluateMemoryRead(p, target()).outcome).toBe('allow');
    for (const patch of [{ principalId: 'other' }, { dataRootId: 'other' }, { binding: 'pending' as const },
      { scope: 'project' as const, projectId: 'other' }, { scope: 'session' as const, sessionId: 'other' }]) {
      expect(evaluateMemoryRead(p, target(patch)).outcome).toBe('deny');
    }
    expect(evaluateMemoryRead(p, target({ kind: 'resource' })).outcome).toBe('deny');
    expect(evaluateMemoryRead({ ...p, disabled: p.selected }, target()).reason).toBe('disabled');
  });
  it('unknown legacy provenance is denied even with explicit global mode', () => {
    expect(evaluateMemoryRead(policy({ readMode: 'global' }), target({ binding: 'pending' })).reason).toBe('pending-binding');
  });
  it('project IDs survive a path move; overlapping path-like IDs grant nothing', () => {
    const p = policy({ readMode: 'project', projectId: 'stable-project-a' });
    expect(evaluateMemoryRead(p, target({ scope: 'project', projectId: 'stable-project-a' })).outcome).toBe('allow');
    expect(evaluateMemoryRead(p, target({ scope: 'project', projectId: 'stable-project-a/child' })).outcome).toBe('deny');
    expect(evaluateMemoryRead(policy({ readMode: 'project' }), target({ scope: 'project', projectId: 'stable-project-a' })).outcome).toBe('deny');
  });
  it('write and read permissions are independent and defaults never become global', () => {
    const p = policy({ readMode: 'none', writeMode: 'automatic' });
    const own = target({ scope: 'session', sessionId: p.sessionId });
    expect(evaluateMemoryRead(p, own).outcome).toBe('deny');
    expect(evaluateMemoryWrite(p, own).outcome).toBe('allow');
    expect(defaultMemoryWriteScope(p)).toEqual({ scope: 'session', scopeKey: 'session-a' });
    expect(defaultMemoryWriteScope({ ...p, projectId: 'project-a' })).toEqual({ scope: 'project', scopeKey: 'project-a' });
    expect(evaluateMemoryWrite({ ...p, readMode: 'global' }, target()).reason).toBe('global-write-grant');
    expect(evaluateMemoryWrite({ ...p, globalWriteGranted: true, writeMode: 'ask' }, target()).outcome).toBe('ask');
    expect(evaluateMemoryWrite({ ...p, writeMode: 'disabled' }, own).outcome).toBe('deny');
    expect(defaultMemoryWriteScope({ ...p, writeMode: 'disabled' })).toBeUndefined();
  });
  it('child decision intersection cannot widen a parent denial or approval requirement', () => {
    const t = target();
    const child = evaluateMemoryRead(policy({ readMode: 'global' }), t);
    const parent = evaluateMemoryRead(policy(), t);
    expect(intersectMemoryAccessDecisions([parent, child]).outcome).toBe('deny');
    expect(intersectMemoryAccessDecisions([child, { outcome: 'ask', reason: 'write-confirmation' }]).outcome).toBe('ask');
    expect(intersectMemoryAccessDecisions([]).outcome).toBe('deny');
  });
  it.each([
    { version: 2 }, { revision: -1 }, { revision: NaN }, { revision: 0.5 },
    { sessionId: '' }, { principalId: ' user' }, { projectId: '' },
    { readMode: 'all' }, { writeMode: 'always' }, { selected: ['memory-a'] },
    { disabled: [{ kind: 'path', id: 'memory-a' }] }, { globalWriteGranted: undefined },
  ])('fails closed for invalid policy %j', (patch) => {
    const p = { ...policy(), ...patch } as MemoryAccessPolicy;
    expect(isMemoryAccessPolicy(p)).toBe(false);
    expect(evaluateMemoryRead(p, target()).reason).toBe('invalid-policy');
    expect(evaluateMemoryWrite(p, target()).reason).toBe('invalid-policy');
    expect(defaultMemoryWriteScope(p)).toBeUndefined();
  });
  it('rejects ambiguous target ownership rather than interpreting legacy scope keys', () => {
    const p = policy({ readMode: 'global' });
    expect(evaluateMemoryRead(p, target({ projectId: 'project-a' })).reason).toBe('invalid-target');
    expect(evaluateMemoryRead(p, target({ scope: 'project' })).reason).toBe('invalid-target');
    expect(evaluateMemoryRead(p, target({ scope: 'workspace' } as unknown as Partial<MemoryAccessTarget>)).reason).toBe('invalid-target');
  });
});
