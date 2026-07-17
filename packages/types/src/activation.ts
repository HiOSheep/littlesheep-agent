// Shared continuous activation model for durable atoms and semantic cache projections.

export const ATOMIC_ACTIVATION_VERSION = 1 as const;
export const MAX_ATOMIC_ACTIVATION_EVIDENCE = 64 as const;
export const MAX_ATOMIC_ACTIVATION_EVENT_IDS = 64 as const;
export const DEFAULT_ATOMIC_ACTIVATION_HALF_LIFE_DAYS = 45;

export type AtomicActivationOutcome = 'useful' | 'not-useful' | 'conflict' | 'stale';
export type AtomicActivationUiLevel = 'high' | 'medium' | 'low';

export interface AtomicActivationLevelCounts {
  high: number;
  medium: number;
  low: number;
}

export interface AtomicActivationEvidence {
  version: typeof ATOMIC_ACTIVATION_VERSION;
  useful: number;
  notUseful: number;
  conflicts: number;
  stale: number;
  verifiedUseful: number;
  verifiedNotUseful: number;
  verifiedConflicts: number;
  verifiedStale: number;
  effectiveScore?: number;
  effectiveEvidenceWeight?: number;
  lastObservedAt?: string;
  lastUsefulAt?: string;
  recentEventIds: string[];
}

export interface AtomicActivationObservation {
  id: string;
  outcome: AtomicActivationOutcome;
  verified: boolean;
  observedAt: string;
}

export interface AtomicActivationSignals {
  createdAt: string;
  useful: number;
  notUseful: number;
  conflicts: number;
  stale: number;
  verifiedUseful: number;
  verifiedNotUseful: number;
  verifiedConflicts: number;
  verifiedStale: number;
  effectiveScore?: number;
  effectiveEvidenceWeight?: number;
  lastObservedAt?: string;
  lastUsefulAt?: string;
}

export interface AtomicActivationSnapshot {
  version: typeof ATOMIC_ACTIVATION_VERSION;
  score: number;
  quality: number;
  frequency: number;
  recency: number;
  evidenceWeight: number;
  protected: boolean;
  computedAt: string;
}

export interface AtomicActivationOptions {
  halfLifeDays?: number;
  protected?: boolean;
}

export interface AtomicActivationUiProjection {
  version: typeof ATOMIC_ACTIVATION_VERSION;
  level: AtomicActivationUiLevel;
  computedAt: string;
}

const DAY_MS = 86_400_000;
const ACTIVATION_FLOOR = 0.05;
const NEW_ATOM_BASELINE = 0.25;

export function createAtomicActivationEvidence(): AtomicActivationEvidence {
  return {
    version: ATOMIC_ACTIVATION_VERSION,
    useful: 0,
    notUseful: 0,
    conflicts: 0,
    stale: 0,
    verifiedUseful: 0,
    verifiedNotUseful: 0,
    verifiedConflicts: 0,
    verifiedStale: 0,
    recentEventIds: [],
  };
}

export function createAtomicActivationLevelCounts(): AtomicActivationLevelCounts {
  return { high: 0, medium: 0, low: 0 };
}

export function applyAtomicActivationObservation(
  currentValue: AtomicActivationEvidence | undefined,
  observation: AtomicActivationObservation,
  halfLifeDays = DEFAULT_ATOMIC_ACTIVATION_HALF_LIFE_DAYS,
): AtomicActivationEvidence {
  const current = normalizeEvidence(currentValue);
  if (current.recentEventIds.includes(observation.id)) return current;
  const currentScore = activationEvidenceScoreAt(current, observation.observedAt, halfLifeDays);
  const currentWeight = activationEvidenceWeightAt(current, observation.observedAt, halfLifeDays);
  const observed = activationObservationValue(observation.outcome);
  const priorWeight = 2;
  const effectiveScore = (
    currentScore * (currentWeight + priorWeight)
    + observed.value * observed.weight
  ) / (currentWeight + priorWeight + observed.weight);
  const next: AtomicActivationEvidence = {
    ...current,
    effectiveScore: clamp01(effectiveScore),
    effectiveEvidenceWeight: Math.min(
      MAX_ATOMIC_ACTIVATION_EVIDENCE,
      currentWeight + observed.weight,
    ),
    lastObservedAt: observation.observedAt,
    lastUsefulAt: observation.outcome === 'useful' ? observation.observedAt : current.lastUsefulAt,
    recentEventIds: [...new Set([...current.recentEventIds, observation.id])]
      .slice(-MAX_ATOMIC_ACTIVATION_EVENT_IDS),
  };
  incrementOutcome(next, observation.outcome, false);
  if (observation.verified) incrementOutcome(next, observation.outcome, true);
  boundCounters(next, false, observation.outcome);
  boundCounters(next, true, observation.outcome);
  return next;
}

export function atomicActivationSignalsFromEvidence(
  evidenceValue: AtomicActivationEvidence | undefined,
  createdAt: string,
): AtomicActivationSignals {
  const evidence = normalizeEvidence(evidenceValue);
  return {
    createdAt,
    useful: evidence.useful,
    notUseful: evidence.notUseful,
    conflicts: evidence.conflicts,
    stale: evidence.stale,
    verifiedUseful: evidence.verifiedUseful,
    verifiedNotUseful: evidence.verifiedNotUseful,
    verifiedConflicts: evidence.verifiedConflicts,
    verifiedStale: evidence.verifiedStale,
    effectiveScore: evidence.effectiveScore,
    effectiveEvidenceWeight: evidence.effectiveEvidenceWeight,
    lastObservedAt: evidence.lastObservedAt,
    lastUsefulAt: evidence.lastUsefulAt,
  };
}

export function computeAtomicActivation(
  input: AtomicActivationSignals,
  nowValue: string,
  options: AtomicActivationOptions = {},
): AtomicActivationSnapshot {
  const halfLifeDays = positiveHalfLife(options.halfLifeDays);
  const routingPositive = boundedCount(input.useful);
  const routingNegative = weightedNegative(input.notUseful, input.conflicts, input.stale);
  const verifiedPositive = boundedCount(input.verifiedUseful) * 2;
  const verifiedNegative = weightedNegative(
    input.verifiedNotUseful,
    input.verifiedConflicts,
    input.verifiedStale,
  ) * 2;
  const routingWeight = Number.isFinite(input.effectiveEvidenceWeight)
    ? Math.max(0, input.effectiveEvidenceWeight!)
    : Math.min(MAX_ATOMIC_ACTIVATION_EVIDENCE, routingPositive + routingNegative);
  const routingQuality = Number.isFinite(input.effectiveScore)
    ? clamp01(input.effectiveScore!)
    : betaMean(routingPositive, routingNegative);
  const verifiedWeight = Math.min(
    MAX_ATOMIC_ACTIVATION_EVIDENCE,
    verifiedPositive + verifiedNegative,
  );
  const verifiedQuality = verifiedWeight > 0
    ? betaMean(verifiedPositive, verifiedNegative)
    : routingQuality;
  const totalEvidenceWeight = Math.min(
    MAX_ATOMIC_ACTIVATION_EVIDENCE,
    routingWeight + verifiedWeight,
  );
  const evidenceConfidence = 1 - Math.exp(-totalEvidenceWeight / 8);
  const frequency = 1 - Math.exp(-(routingPositive + verifiedPositive) / 8);
  const quality = clamp01(routingQuality * 0.55 + verifiedQuality * 0.45);
  const learned = clamp01(quality * 0.7 + frequency * 0.3);
  const evidenceAdjusted = NEW_ATOM_BASELINE * (1 - evidenceConfidence)
    + learned * evidenceConfidence;
  const recencyAt = input.lastUsefulAt ?? input.lastObservedAt ?? input.createdAt;
  const ageDays = timestampAgeDays(nowValue, recencyAt);
  const recency = Math.pow(0.5, ageDays / halfLifeDays);
  const protectedAtom = options.protected === true;
  const score = protectedAtom
    ? 1
    : clamp01(ACTIVATION_FLOOR + Math.max(0, evidenceAdjusted - ACTIVATION_FLOOR) * recency);
  return {
    version: ATOMIC_ACTIVATION_VERSION,
    score,
    quality,
    frequency,
    recency,
    evidenceWeight: totalEvidenceWeight,
    protected: protectedAtom,
    computedAt: validTimestamp(nowValue),
  };
}

export function decayAtomicActivationScore(
  scoreValue: number,
  computedAt: string,
  nowValue: string,
  halfLifeDays = DEFAULT_ATOMIC_ACTIVATION_HALF_LIFE_DAYS,
): number {
  const score = clamp01(scoreValue);
  if (score >= 1) return 1;
  const ageDays = timestampAgeDays(nowValue, computedAt);
  const retention = Math.pow(0.5, ageDays / positiveHalfLife(halfLifeDays));
  return clamp01(ACTIVATION_FLOOR + Math.max(0, score - ACTIVATION_FLOOR) * retention);
}

export function projectAtomicActivationLevel(
  scoreValue: number,
  previous?: AtomicActivationUiLevel,
): AtomicActivationUiLevel {
  const score = clamp01(scoreValue);
  if (previous === 'high') {
    if (score >= 0.61) return 'high';
    return score >= 0.28 ? 'medium' : 'low';
  }
  if (previous === 'medium') {
    if (score >= 0.71) return 'high';
    return score >= 0.28 ? 'medium' : 'low';
  }
  if (previous === 'low') {
    if (score >= 0.71) return 'high';
    return score >= 0.38 ? 'medium' : 'low';
  }
  if (score >= 0.66) return 'high';
  return score >= 0.33 ? 'medium' : 'low';
}

export function atomicActivationUiProjection(
  score: number,
  computedAt: string,
  previous?: AtomicActivationUiLevel,
): AtomicActivationUiProjection {
  return {
    version: ATOMIC_ACTIVATION_VERSION,
    level: projectAtomicActivationLevel(score, previous),
    computedAt: validTimestamp(computedAt),
  };
}

function normalizeEvidence(value: AtomicActivationEvidence | undefined): AtomicActivationEvidence {
  const empty = createAtomicActivationEvidence();
  if (!value || value.version !== ATOMIC_ACTIVATION_VERSION) return empty;
  return {
    version: ATOMIC_ACTIVATION_VERSION,
    useful: boundedCount(value.useful),
    notUseful: boundedCount(value.notUseful),
    conflicts: boundedCount(value.conflicts),
    stale: boundedCount(value.stale),
    verifiedUseful: boundedCount(value.verifiedUseful),
    verifiedNotUseful: boundedCount(value.verifiedNotUseful),
    verifiedConflicts: boundedCount(value.verifiedConflicts),
    verifiedStale: boundedCount(value.verifiedStale),
    effectiveScore: Number.isFinite(value.effectiveScore) ? clamp01(value.effectiveScore!) : undefined,
    effectiveEvidenceWeight: Number.isFinite(value.effectiveEvidenceWeight)
      ? Math.max(0, Math.min(MAX_ATOMIC_ACTIVATION_EVIDENCE, value.effectiveEvidenceWeight!))
      : undefined,
    lastObservedAt: validOptionalTimestamp(value.lastObservedAt),
    lastUsefulAt: validOptionalTimestamp(value.lastUsefulAt),
    recentEventIds: [...new Set(value.recentEventIds.filter(Boolean))]
      .slice(-MAX_ATOMIC_ACTIVATION_EVENT_IDS),
  };
}

function activationEvidenceScoreAt(
  evidence: AtomicActivationEvidence,
  nowValue: string,
  halfLifeDays: number,
): number {
  const observed = Number.isFinite(evidence.effectiveScore)
    ? clamp01(evidence.effectiveScore!)
    : betaMean(evidence.useful, weightedNegative(evidence.notUseful, evidence.conflicts, evidence.stale));
  if (!evidence.lastObservedAt) return observed;
  const retention = Math.pow(0.5, timestampAgeDays(nowValue, evidence.lastObservedAt) / positiveHalfLife(halfLifeDays));
  return clamp01(0.5 + (observed - 0.5) * retention);
}

function activationEvidenceWeightAt(
  evidence: AtomicActivationEvidence,
  nowValue: string,
  halfLifeDays: number,
): number {
  const base = Number.isFinite(evidence.effectiveEvidenceWeight)
    ? Math.max(0, evidence.effectiveEvidenceWeight!)
    : Math.min(
        MAX_ATOMIC_ACTIVATION_EVIDENCE,
        evidence.useful + weightedNegative(evidence.notUseful, evidence.conflicts, evidence.stale),
      );
  if (!evidence.lastObservedAt) return base;
  const retention = Math.pow(0.5, timestampAgeDays(nowValue, evidence.lastObservedAt) / positiveHalfLife(halfLifeDays));
  return base * retention;
}

function incrementOutcome(
  evidence: AtomicActivationEvidence,
  outcome: AtomicActivationOutcome,
  verified: boolean,
): void {
  if (outcome === 'useful') evidence[verified ? 'verifiedUseful' : 'useful'] += 1;
  else if (outcome === 'not-useful') evidence[verified ? 'verifiedNotUseful' : 'notUseful'] += 1;
  else if (outcome === 'conflict') evidence[verified ? 'verifiedConflicts' : 'conflicts'] += 1;
  else evidence[verified ? 'verifiedStale' : 'stale'] += 1;
}

function boundCounters(
  evidence: AtomicActivationEvidence,
  verified: boolean,
  latest: AtomicActivationOutcome,
): void {
  const keys = verified
    ? ['verifiedUseful', 'verifiedNotUseful', 'verifiedConflicts', 'verifiedStale'] as const
    : ['useful', 'notUseful', 'conflicts', 'stale'] as const;
  const total = keys.reduce((sum, key) => sum + evidence[key], 0);
  if (total <= MAX_ATOMIC_ACTIVATION_EVIDENCE) return;
  for (const key of keys) evidence[key] = Math.floor(evidence[key] / 2);
  const latestKey = latest === 'useful'
    ? keys[0]
    : latest === 'not-useful'
      ? keys[1]
      : latest === 'conflict'
        ? keys[2]
        : keys[3];
  evidence[latestKey] = Math.max(1, evidence[latestKey]);
}

function activationObservationValue(outcome: AtomicActivationOutcome): { value: number; weight: number } {
  if (outcome === 'useful') return { value: 1, weight: 1 };
  if (outcome === 'conflict') return { value: 0, weight: 1.5 };
  if (outcome === 'stale') return { value: 0, weight: 1.25 };
  return { value: 0, weight: 1 };
}

function weightedNegative(notUseful: number, conflicts: number, stale: number): number {
  return boundedCount(notUseful) + boundedCount(conflicts) * 1.5 + boundedCount(stale) * 1.25;
}

function betaMean(positive: number, negative: number): number {
  return (Math.max(0, positive) + 1) / (Math.max(0, positive) + Math.max(0, negative) + 2);
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_ATOMIC_ACTIVATION_EVIDENCE, Math.floor(value)));
}

function timestampAgeDays(nowValue: string, thenValue: string): number {
  const now = Date.parse(nowValue);
  const then = Date.parse(thenValue);
  if (!Number.isFinite(now) || !Number.isFinite(then)) return 0;
  return Math.max(0, now - then) / DAY_MS;
}

function positiveHalfLife(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_ATOMIC_ACTIVATION_HALF_LIFE_DAYS;
  }
  return Math.max(1, value);
}

function validTimestamp(value: string): string {
  return Number.isFinite(Date.parse(value)) ? value : new Date(0).toISOString();
}

function validOptionalTimestamp(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
