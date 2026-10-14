// Pure P1A decisions only: no IO, tokenization, migrations, or production defaults.
import type { MemoryAccessDecision, MemoryAccessPolicy, MemoryAccessReference, MemoryAccessTarget } from '@littlesheep/types';

const id = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 512 && value.trim() === value;
const reference = (value: unknown): value is MemoryAccessReference => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<MemoryAccessReference>;
  return (entry.kind === 'atom' || entry.kind === 'resource') && id(entry.id);
};
const references = (value: unknown): value is MemoryAccessReference[] => Array.isArray(value)
  && value.length <= 1024 && value.every(reference);

/** Shape validation only. Host ownership/settings verification remains mandatory. */
export function isMemoryAccessPolicy(value: unknown): value is MemoryAccessPolicy {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<MemoryAccessPolicy>;
  return p.version === 1 && Number.isSafeInteger(p.revision) && (p.revision ?? -1) >= 0
    && id(p.principalId) && id(p.dataRootId) && id(p.sessionId) && id(p.runId)
    && (p.projectId === undefined || id(p.projectId))
    && ['none', 'project', 'global', 'manual'].includes(p.readMode ?? '')
    && ['disabled', 'ask', 'automatic'].includes(p.writeMode ?? '')
    && references(p.selected) && references(p.disabled) && typeof p.globalWriteGranted === 'boolean';
}

export function isMemoryAccessTarget(t: MemoryAccessTarget): boolean {
  return reference(t) && id(t.principalId) && id(t.dataRootId)
    && (t.binding === 'reviewed' || t.binding === 'pending')
    && ((t.scope === 'global' && t.projectId === undefined && t.sessionId === undefined)
      || (t.scope === 'project' && id(t.projectId) && t.sessionId === undefined)
      || (t.scope === 'session' && id(t.sessionId) && t.projectId === undefined));
}
const matches = (list: readonly MemoryAccessReference[], t: MemoryAccessReference) =>
  list.some((item) => item.kind === t.kind && item.id === t.id);
const deny = (reason: Extract<MemoryAccessDecision, { outcome: 'deny' }>['reason']): MemoryAccessDecision => ({ outcome: 'deny', reason });

function boundary(p: MemoryAccessPolicy, t: MemoryAccessTarget): MemoryAccessDecision | undefined {
  if (!isMemoryAccessPolicy(p)) return deny('invalid-policy');
  if (!isMemoryAccessTarget(t)) return deny('invalid-target');
  if (p.principalId !== t.principalId || p.dataRootId !== t.dataRootId) return deny('ownership');
  if (t.binding !== 'reviewed') return deny('pending-binding');
  if (matches(p.disabled, t)) return deny('disabled');
  if ((t.scope === 'project' && (!p.projectId || t.projectId !== p.projectId))
    || (t.scope === 'session' && t.sessionId !== p.sessionId)) return deny('scope');
  return undefined;
}

/** Apply before metadata disclosure and again before body/materialization. */
export function evaluateMemoryRead(p: MemoryAccessPolicy, t: MemoryAccessTarget): MemoryAccessDecision {
  const rejected = boundary(p, t);
  if (rejected) return rejected;
  if (p.readMode === 'none') return deny('read-disabled');
  if (p.readMode === 'manual') {
    return matches(p.selected, t) ? { outcome: 'allow', reason: 'authorized' } : deny('not-selected');
  }
  if (p.readMode === 'project' && (t.scope === 'global' || !p.projectId)) return deny('scope');
  return { outcome: 'allow', reason: 'authorized' };
}

/** Does not replace Safety approval, evidence validation, or repository invariants. */
export function evaluateMemoryWrite(p: MemoryAccessPolicy, t: MemoryAccessTarget): MemoryAccessDecision {
  const rejected = boundary(p, t);
  if (rejected) return rejected;
  if (p.writeMode === 'disabled') return deny('write-disabled');
  if (t.scope === 'global' && !p.globalWriteGranted) return deny('global-write-grant');
  return p.writeMode === 'ask' ? { outcome: 'ask', reason: 'write-confirmation' }
    : { outcome: 'allow', reason: 'authorized' };
}

/** Runtime chooses this destination; model scope suggestions cannot widen it. */
export function defaultMemoryWriteScope(p: MemoryAccessPolicy):
  { scope: 'project' | 'session'; scopeKey: string } | undefined {
  if (!isMemoryAccessPolicy(p) || p.writeMode === 'disabled') return undefined;
  return p.projectId ? { scope: 'project', scopeKey: p.projectId }
    : { scope: 'session', scopeKey: p.sessionId };
}

/** Host must retain every ancestor decision for a child run; no mode ranking. */
export function intersectMemoryAccessDecisions(decisions: readonly MemoryAccessDecision[]): MemoryAccessDecision {
  if (decisions.length === 0) return deny('invalid-policy');
  return decisions.find((d) => d.outcome === 'deny')
    ?? decisions.find((d) => d.outcome === 'ask') ?? { outcome: 'allow', reason: 'authorized' };
}
