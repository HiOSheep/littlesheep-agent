// P1B-1 bounded in-memory CAS foundation; not a durable sidecar or migration proof.
import type { MemoryAccessReference, MemoryAccessTarget } from '@littlesheep/types';
import { isMemoryAccessTarget } from './memory-access-policy.js';
export interface MemoryOwnershipBinding {
  version: 1;
  revision: number;
  /** Atom revision/resource registration version checked by the eventual storage adapter. */
  entityRevision: string;
  target: MemoryAccessTarget;
}
export interface MemoryOwnershipBindingStore {
  get(reference: MemoryAccessReference): MemoryOwnershipBinding | undefined;
  compareAndSet(binding: MemoryOwnershipBinding, expectedRevision: number | undefined): void;
}
export class InMemoryOwnershipBindings implements MemoryOwnershipBindingStore {
  private readonly entries = new Map<string, MemoryOwnershipBinding>();
  constructor(private readonly capacity = 1024) {}
  private key(ref: MemoryAccessReference) { return JSON.stringify([ref.kind, ref.id]); }
  get(reference: MemoryAccessReference) {
    const entry = this.entries.get(this.key(reference));
    return entry ? structuredClone(entry) : undefined;
  }
  compareAndSet(binding: MemoryOwnershipBinding, expectedRevision: number | undefined): void {
    if (!isMemoryAccessTarget(binding.target)) throw new Error('Invalid ownership target');
    const targetKeys = ['kind', 'id', 'principalId', 'dataRootId', 'binding', 'scope', 'projectId', 'sessionId'];
    if (Object.keys(binding).some((key) => !['version', 'revision', 'entityRevision', 'target'].includes(key))
      || Object.keys(binding.target).some((key) => !targetKeys.includes(key))) throw new Error('Ownership bindings cannot contain content');
    const key = this.key(binding.target);
    const existing = this.entries.get(key);
    const serialized = (b: MemoryOwnershipBinding) => JSON.stringify([b.version, b.revision, b.entityRevision,
      ...targetKeys.map((field) => b.target[field as keyof MemoryAccessTarget])]);
    if (existing && binding.revision === existing.revision && serialized(binding) === serialized(existing)
      && expectedRevision === (existing.revision === 0 ? undefined : existing.revision - 1)) return;
    if (binding.version !== 1 || !binding.entityRevision || !Number.isSafeInteger(binding.revision)
      || binding.revision !== (expectedRevision === undefined ? 0 : expectedRevision + 1)
      || existing?.revision !== expectedRevision
      || (existing && (existing.target.dataRootId !== binding.target.dataRootId || existing.target.principalId !== binding.target.principalId))) throw new Error('Ownership binding revision conflict');
    if (!existing && this.entries.size >= this.capacity) throw new Error('Ownership binding capacity exceeded');
    this.entries.set(key, structuredClone(binding));
  }
}
