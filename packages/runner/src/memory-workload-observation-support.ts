// Bounded aggregation helpers for Memory v3 workload reports.

import type { MemoryWorkloadObservation } from './memory-workload-observation-contracts.js';

export function incrementFixed(target: Record<string, number>, value: unknown): void {
  const key = typeof value === 'string' && Object.hasOwn(target, value) ? value : 'other';
  target[key] = (target[key] ?? 0) + 1;
}

export function incrementVerdict(
  target: MemoryWorkloadObservation['quality']['verificationVerdicts'],
  value: unknown,
): void {
  if (value === 'pass') target.pass += 1;
  else if (value === 'needs_replan') target.needsReplan += 1;
  else if (value === 'fail') target.fail += 1;
  else target.other += 1;
}

export function incrementTaskExecution(
  target: MemoryWorkloadObservation['quality']['taskExecution'],
  value: unknown,
): void {
  if (value === 'done') target.done += 1;
  else if (value === 'failed' || value === 'blocked' || value === 'partial') target.incomplete += 1;
  else target.other += 1;
}

export function incrementBounded(target: Record<string, number>, value: unknown, maxKeys: number): void {
  const normalized = typeof value === 'string' && value.trim() ? value.trim() : 'other';
  const key = Object.hasOwn(target, normalized) || Object.keys(target).length < maxKeys ? normalized : 'other';
  target[key] = (target[key] ?? 0) + 1;
}

export function differenceCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const value of left) if (!right.has(value)) count += 1;
  return count;
}

export function boundedArray<T>(
  value: readonly T[] | undefined,
  maximum: number,
): { items: readonly T[]; truncated: boolean } {
  if (!Array.isArray(value)) return { items: [], truncated: false };
  return { items: value.slice(0, maximum), truncated: value.length > maximum };
}

export function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

export function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function boundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

export function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}
