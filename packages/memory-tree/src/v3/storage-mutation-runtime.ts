// Validates persisted storage mutations and provides idempotent replay guards.

import type { MemoryAtom, MemoryStorageMutation } from './contracts.js';
import { MemoryAtomStore } from './atom-store.js';
import { canonicalJson } from './durable-json.js';

export function parseStorageMutation(value: unknown): MemoryStorageMutation {
  if (!value || typeof value !== 'object') throw new Error('Memory event is missing its storage mutation payload.');
  const mutation = value as Partial<MemoryStorageMutation> & Record<string, unknown>;
  if (mutation.kind === 'create' && mutation.atom && typeof mutation.atom === 'object') {
    return structuredClone(mutation as Extract<MemoryStorageMutation, { kind: 'create' }>);
  }
  if (mutation.kind === 'update'
    && typeof mutation.atomId === 'string'
    && Number.isInteger(mutation.expectedRevision)
    && mutation.patch && typeof mutation.patch === 'object') {
    return structuredClone(mutation as Extract<MemoryStorageMutation, { kind: 'update' }>);
  }
  if ((mutation.kind === 'archive' || mutation.kind === 'restore')
    && typeof mutation.atomId === 'string'
    && Number.isInteger(mutation.expectedRevision)) {
    return structuredClone(mutation as Extract<MemoryStorageMutation, { kind: 'archive' | 'restore' }>);
  }
  if (mutation.kind === 'merge'
    && typeof mutation.targetAtomId === 'string'
    && Number.isInteger(mutation.targetExpectedRevision)
    && mutation.targetPatch && typeof mutation.targetPatch === 'object'
    && typeof mutation.sourceAtomId === 'string'
    && Number.isInteger(mutation.sourceExpectedRevision)
    && mutation.sourcePatch && typeof mutation.sourcePatch === 'object') {
    return structuredClone(mutation as Extract<MemoryStorageMutation, { kind: 'merge' }>);
  }
  throw new Error('Memory event contains an invalid storage mutation payload.');
}

export function mutationAtomIds(mutation: MemoryStorageMutation): string[] {
  if (mutation.kind === 'create') return [mutation.atom.id];
  if (mutation.kind === 'merge') return [mutation.targetAtomId, mutation.sourceAtomId];
  return [mutation.atomId];
}

export function mutationExpectedRevisions(mutation: MemoryStorageMutation): Record<string, number> {
  if (mutation.kind === 'create') return { [mutation.atom.id]: 0 };
  if (mutation.kind === 'merge') {
    return {
      [mutation.targetAtomId]: mutation.targetExpectedRevision,
      [mutation.sourceAtomId]: mutation.sourceExpectedRevision,
    };
  }
  return { [mutation.atomId]: mutation.expectedRevision };
}

export function matchesDefinedFields(target: object, expected: object): boolean {
  const targetRecord = target as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .every(([key, value]) => canonicalJson(targetRecord[key]) === canonicalJson(value));
}

export function assertUpdateCanResume(
  existing: MemoryAtom | undefined,
  atomId: string,
  expectedRevision: number,
  patch: Extract<MemoryStorageMutation, { kind: 'update' }>['patch'],
  label: string,
): void {
  if (!existing) throw new Error(`Memory atom not found during ${label}: ${atomId}`);
  if (existing.revision === expectedRevision) return;
  if (existing.revision === expectedRevision + 1 && matchesDefinedFields(existing, patch)) return;
  throw new Error(`Memory atom ${existing.id} changed after the captured ${label} mutation.`);
}

export function requiredRelativePath(store: MemoryAtomStore, atomId: string): string {
  const path = store.relativePathFor(atomId);
  if (!path) throw new Error(`Memory atom has no registered file path: ${atomId}`);
  return path;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function classifyMutationProjection(
  store: MemoryAtomStore,
  mutation: MemoryStorageMutation,
): Promise<'pending' | 'committed'> {
  if (mutation.kind === 'create') {
    const existing = await store.read(mutation.atom.id);
    if (!existing) return 'pending';
    if (matchesDefinedFields(existing, mutation.atom)) return 'committed';
    throw new Error(`Immutable fact conflicts with existing atom ${mutation.atom.id}.`);
  }
  if (mutation.kind === 'merge') {
    const [target, source] = await Promise.all([
      store.read(mutation.targetAtomId),
      store.read(mutation.sourceAtomId),
    ]);
    const targetState = mutationPatchProjection(
      target,
      mutation.targetAtomId,
      mutation.targetExpectedRevision,
      mutation.targetPatch,
      'merge target',
    );
    const sourceState = mutationPatchProjection(
      source,
      mutation.sourceAtomId,
      mutation.sourceExpectedRevision,
      mutation.sourcePatch,
      'merge source',
    );
    return targetState === 'committed' && sourceState === 'committed' ? 'committed' : 'pending';
  }
  const existing = await store.read(mutation.atomId);
  if (!existing) throw new Error(`Immutable fact references missing atom ${mutation.atomId}.`);
  if (mutation.kind === 'update') {
    return mutationPatchProjection(existing, mutation.atomId, mutation.expectedRevision, mutation.patch, 'update');
  }
  if (existing.revision === mutation.expectedRevision) return 'pending';
  const expectedStatus = mutation.kind === 'archive' ? 'archived' : 'active';
  if (existing.revision === mutation.expectedRevision + 1 && existing.status === expectedStatus) return 'committed';
  throw new Error(`Immutable ${mutation.kind} fact has an ambiguous projection for atom ${existing.id}.`);
}

function mutationPatchProjection(
  existing: MemoryAtom | undefined,
  atomId: string,
  expectedRevision: number,
  patch: Extract<MemoryStorageMutation, { kind: 'update' }>['patch'],
  label: string,
): 'pending' | 'committed' {
  if (!existing) throw new Error(`Immutable ${label} fact references missing atom ${atomId}.`);
  if (existing.revision === expectedRevision) return 'pending';
  if (existing.revision === expectedRevision + 1 && matchesDefinedFields(existing, patch)) return 'committed';
  throw new Error(`Immutable ${label} fact has an ambiguous projection for atom ${existing.id}.`);
}
