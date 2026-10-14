// Run-bound Atom read gate. Ownership comes only from a trusted binding store, never storage scope.
import { createHash } from 'node:crypto';
import type { MemoryNode } from './types.js';
import type { MemoryOwnershipBindingStore } from './memory-ownership-bindings.js';
import { evaluateMemoryAccessContext, MemoryAccessAuthorizationError, memoryAccessContextIsCurrent,
  type MemoryAccessContext } from './memory-access-context.js';

export interface AtomReadAuthorization {
  assertCurrent(): Promise<void>;
  references(): Promise<string[]>;
  allows(id: string, revision?: string): Promise<boolean>;
}
const gates = new WeakSet<object>();
export function assertAtomReadAuthorization(gate: AtomReadAuthorization): void {
  if (!gate || !gates.has(gate)) throw new MemoryAccessAuthorizationError('Memory authorization unavailable');
}

/** v2 has no monotonic Atom revision. A bound full-node fingerprint is a distinct protocol. */
export function memoryNodeAccessRevision(node: MemoryNode): string {
  return `v2:${createHash('sha256').update(JSON.stringify(node)).digest('hex')}`;
}

export function createAtomReadAuthorization(context: MemoryAccessContext, store: MemoryOwnershipBindingStore): AtomReadAuthorization {
  const assertCurrent = async () => {
    if (!await memoryAccessContextIsCurrent(context)) throw new MemoryAccessAuthorizationError('Memory authorization unavailable');
  };
  const allows = async (id: string, revision?: string) => {
    await assertCurrent();
    const binding = store.get({ kind: 'atom', id });
    if (!binding || binding.target.binding !== 'reviewed' || (revision !== undefined && binding.entityRevision !== revision)) return false;
    const decision = await evaluateMemoryAccessContext(context, binding.target, 'read');
    await assertCurrent();
    const current = store.get({ kind: 'atom', id });
    return decision.outcome === 'allow' && !!current && current.revision === binding.revision
      && current.entityRevision === binding.entityRevision;
  };
  const gate: AtomReadAuthorization = Object.freeze({ assertCurrent, allows, references: async () => {
    await assertCurrent();
    const ids: string[] = [];
    for (const binding of store.list()) if (binding.target.kind === 'atom' && await allows(binding.target.id)) ids.push(binding.target.id);
    return ids;
  } });
  gates.add(gate);
  return gate;
}
