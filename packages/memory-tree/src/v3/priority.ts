import { InjectionTier } from '../types.js';
import type { MemoryCandidatePriorityBreakdown, MemoryCandidatePriorityInput } from './contracts.js';

const DAY_MS = 86_400_000;

export function scoreMemoryCandidate(input: MemoryCandidatePriorityInput): MemoryCandidatePriorityBreakdown {
  const now = Date.parse(input.now);
  const updatedAt = Date.parse(input.atom.updatedAt);
  const lastUsefulAt = input.atom.lastUsefulAt ? Date.parse(input.atom.lastUsefulAt) : Number.NaN;
  const freshnessAge = Number.isFinite(now) && Number.isFinite(updatedAt)
    ? Math.max(0, now - updatedAt) / DAY_MS
    : 0;
  const usefulnessAge = Number.isFinite(now) && Number.isFinite(lastUsefulAt)
    ? Math.max(0, now - lastUsefulAt) / DAY_MS
    : freshnessAge;
  const halfLife = Math.max(1, input.decayHalfLifeDays);
  const freshness = Math.pow(0.5, freshnessAge / Math.max(halfLife * 2, 1));
  const protectedMemory = input.atom.tier === InjectionTier.T0_CORE
    || input.requiredByCurrentUser
    || input.safetyCritical;
  const usefulnessDecay = protectedMemory ? 1 : Math.pow(0.5, usefulnessAge / halfLife);
  const expired = Boolean(input.atom.expiresAt && Number.isFinite(now) && Date.parse(input.atom.expiresAt) <= now);
  const disputed = input.atom.epistemicStatus === 'disputed';
  const inactive = input.atom.status !== 'active';
  const superseded = input.atom.epistemicStatus === 'superseded'
    || input.atom.resolutionStatus === 'superseded';
  const penalties: string[] = [];
  if (expired) penalties.push('expired');
  if (disputed) penalties.push('disputed');
  if (inactive) penalties.push(`status:${input.atom.status}`);
  if (superseded) penalties.push('superseded');

  const factors = {
    scope: clamp01(input.scopeMatch) * 0.22,
    task: clamp01(input.taskRelevance) * 0.24,
    authority: clamp01(input.authorityMatch) * 0.14,
    confidence: clamp01(input.atom.confidence) * 0.12,
    importance: clamp01(input.atom.importance) * 0.10,
    basePriority: clamp01(input.atom.basePriority) * 0.08,
    verifiedUsefulness: clamp01(input.verifiedUsefulness) * usefulnessDecay * 0.07,
    freshness: freshness * 0.03,
  };
  const raw = Object.values(factors).reduce((sum, value) => sum + value, 0);
  const penalty = (expired ? 0.35 : 0)
    + (disputed ? 0.25 : 0)
    + (inactive ? 1 : 0)
    + (superseded ? 0.5 : 0);
  const eligible = protectedMemory
    ? input.atom.status === 'active' && !superseded
    : input.atom.status === 'active' && !expired && !superseded;

  return {
    score: eligible ? clamp01(raw - penalty) : 0,
    eligible,
    protected: protectedMemory,
    freshness,
    usefulnessDecay,
    penalties,
    factors,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
