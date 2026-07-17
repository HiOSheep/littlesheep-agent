import { InjectionTier } from '../types.js';
import type {
  MemoryAtom,
  MemoryCandidatePriorityBreakdown,
  MemoryCandidatePriorityInput,
} from './contracts.js';
import { memoryAtomActivation } from './activation.js';

const DAY_MS = 86_400_000;
const DEFAULT_ROUTING_HALF_LIFE_DAYS = 90;

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
  const taskRelevance = clamp01(input.taskRelevance);
  const routingRelevance = clamp01(input.routingRelevance);
  const routingBias = 0.65 + routingRelevance * 0.7;
  const routingMultiplier = protectedMemory
    ? 1
    : 1 + (routingBias - 1) * taskRelevance;
  const taskAdmissionMultiplier = protectedMemory ? 1 : 0.45 + taskRelevance * 0.55;
  const rawRelationshipRelevance = clamp01(input.relationshipRelevance);
  const relationshipRelevance = 0.5 + (rawRelationshipRelevance - 0.5) * taskRelevance;
  const relationshipMultiplier = protectedMemory ? 1 : 0.9 + relationshipRelevance * 0.2;
  const activation = memoryAtomActivation(input.atom, input.now, protectedMemory);
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
    task: taskRelevance * 0.24,
    authority: clamp01(input.authorityMatch) * 0.14,
    confidence: clamp01(input.atom.confidence) * 0.12,
    importance: clamp01(input.atom.importance) * 0.10,
    basePriority: clamp01(input.atom.basePriority) * 0.08,
    activation: activation.score * 0.07,
    freshness: freshness * 0.03,
  };
  const raw = Object.values(factors).reduce((sum, value) => sum + value, 0)
    * taskAdmissionMultiplier
    * routingMultiplier
    * relationshipMultiplier;
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
    taskRelevance,
    freshness,
    usefulnessDecay,
    routingRelevance,
    routingMultiplier,
    relationshipRelevance,
    relationshipMultiplier,
    activation,
    penalties,
    factors,
  };
}

export function memoryRoutingRelevance(
  atom: MemoryAtom,
  nowValue: string,
  halfLifeDays = DEFAULT_ROUTING_HALF_LIFE_DAYS,
): number {
  return memoryRoutingFeedbackRelevance(atom.routingFeedback, nowValue, halfLifeDays);
}

export function memoryRoutingFeedbackRelevance(
  feedback: MemoryAtom['routingFeedback'],
  nowValue: string,
  halfLifeDays = DEFAULT_ROUTING_HALF_LIFE_DAYS,
): number {
  if (!feedback) return 0.5;
  const observed = Number.isFinite(feedback.effectiveRelevance)
    ? clamp01(feedback.effectiveRelevance!)
    : observedRoutingRelevance(feedback);
  const now = Date.parse(nowValue);
  const lastRoutedAt = feedback.lastRoutedAt ? Date.parse(feedback.lastRoutedAt) : Number.NaN;
  if (!Number.isFinite(now) || !Number.isFinite(lastRoutedAt)) return clamp01(observed);
  const ageDays = Math.max(0, now - lastRoutedAt) / DAY_MS;
  const retention = Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
  return clamp01(0.5 + (observed - 0.5) * retention);
}

export function memoryRoutingEvidenceWeight(
  feedback: MemoryAtom['routingFeedback'],
  nowValue: string,
  halfLifeDays = DEFAULT_ROUTING_HALF_LIFE_DAYS,
): number {
  if (!feedback) return 0;
  const base = Number.isFinite(feedback.effectiveEvidenceWeight)
    ? Math.max(0, feedback.effectiveEvidenceWeight!)
    : Math.min(64, routingEvidenceWeight(feedback));
  const now = Date.parse(nowValue);
  const lastRoutedAt = feedback.lastRoutedAt ? Date.parse(feedback.lastRoutedAt) : Number.NaN;
  if (!Number.isFinite(now) || !Number.isFinite(lastRoutedAt)) return base;
  const ageDays = Math.max(0, now - lastRoutedAt) / DAY_MS;
  return base * Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
}

function observedRoutingRelevance(feedback: NonNullable<MemoryAtom['routingFeedback']>): number {
  const positive = Math.max(0, feedback.useful);
  const negative = Math.max(0, feedback.notUseful)
    + Math.max(0, feedback.conflicts) * 1.5
    + Math.max(0, feedback.stale) * 1.25;
  if (positive + negative === 0) return 0.5;
  return (positive + 1) / (positive + negative + 2);
}

function routingEvidenceWeight(feedback: NonNullable<MemoryAtom['routingFeedback']>): number {
  return Math.max(0, feedback.useful)
    + Math.max(0, feedback.notUseful)
    + Math.max(0, feedback.conflicts) * 1.5
    + Math.max(0, feedback.stale) * 1.25;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
