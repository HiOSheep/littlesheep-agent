// Filters model-reported memory use against the run's authoritative working set.

import type { RunContext } from '@littlesheep/types';

const MAX_USED_MEMORY_ATOMS = 64;

export function acceptedUsedMemoryAtomIds(ctx: RunContext, value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const active = new Set(ctx.memoryContextWorkingSet?.activeAtomIds ?? []);
  const adopted = new Set((ctx.memoryKnownState?.references ?? [])
    .filter((reference) => reference.decision === 'adopted')
    .map((reference) => reference.atomId));
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item && active.has(item) && adopted.has(item)))]
    .slice(0, MAX_USED_MEMORY_ATOMS);
}
