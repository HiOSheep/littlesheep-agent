// Normalizes graph hints and derives runtime-owned relation governance metadata.

import type { MemoryScope, MemoryWriteIntent } from '../types.js';
import type {
  AuthorityScope,
  MemoryActorRef,
  MemoryEntity,
  MemoryEntityType,
  MemoryRelation,
  MemoryRelationType,
  MemoryResolutionStatus,
  MemoryWriteEntityHint,
  MemoryWriteRelationHint,
} from '../v3/contracts.js';
import { memoryV3EntityId } from './v3-node-mapping.js';
import type { ClassifiedMemoryStatement } from './v3-statement.js';

const MAX_ENTITY_HINTS = 12;
const MAX_RELATION_HINTS = 16;
const ACTIVATABLE_RESOLUTIONS = new Set<MemoryResolutionStatus>(['adopted', 'resolved']);
const SELF_AUTHORITATIVE_STATEMENTS = new Set([
  'instruction', 'goal', 'preference', 'value', 'decision', 'approval',
]);
const ENTITY_TYPES = new Set<MemoryEntityType>([
  'user', 'project', 'directory', 'file', 'session', 'task', 'skill', 'tool',
  'rule', 'concept', 'external-source',
]);
const RELATION_TYPES = new Set<MemoryRelationType>([
  'belongs-to', 'depends-on', 'references', 'conflicts-with', 'replaces',
  'derived-from', 'similar-to', 'affects', 'supported-by',
]);

export function buildHintedEntity(input: {
  hint: MemoryWriteEntityHint;
  intent: MemoryWriteIntent;
  classification: ClassifiedMemoryStatement;
  storageScopeKey: string | undefined;
  now: string;
  existing?: MemoryEntity;
}): MemoryEntity | undefined {
  if (input.existing && input.existing.status !== 'active') return undefined;
  const id = memoryV3EntityId(
    input.hint.type,
    input.intent.scope,
    input.storageScopeKey,
    input.hint.stableKey,
  );
  const aliases = uniqueStrings([
    ...(input.existing?.aliases ?? []),
    ...(input.existing && input.existing.label !== input.hint.label ? [input.hint.label] : []),
    ...(input.hint.aliases ?? []),
  ], 32);
  const owner = input.existing?.owner ?? entityOwner(input.hint.type, input.classification.assertedBy);
  const next: MemoryEntity = {
    version: 1,
    id,
    type: input.hint.type,
    owner,
    scope: input.intent.scope,
    scopeKey: input.storageScopeKey,
    externalKey: input.hint.stableKey,
    label: input.existing?.label ?? input.hint.label,
    aliases,
    status: 'active',
    revision: (input.existing?.revision ?? 0) + 1,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  if (input.existing && entityEquivalent(input.existing, next)) return input.existing;
  return next;
}

export function normalizeEntityHints(value: unknown): MemoryWriteEntityHint[] {
  if (!Array.isArray(value)) return [];
  const hints = new Map<string, MemoryWriteEntityHint>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Partial<MemoryWriteEntityHint>;
    const stableKey = normalizedKey(raw.stableKey);
    const type = typeof raw.type === 'string' && ENTITY_TYPES.has(raw.type as MemoryEntityType)
      ? raw.type as MemoryEntityType
      : undefined;
    const label = clean(raw.label, 160);
    if (!stableKey || !type || !label) continue;
    hints.set(stableKey, {
      stableKey,
      type,
      label,
      aliases: uniqueStrings(Array.isArray(raw.aliases) ? raw.aliases : [], 8),
    });
    if (hints.size >= MAX_ENTITY_HINTS) break;
  }
  return [...hints.values()];
}

export function normalizeRelationHints(
  value: unknown,
  entities: ReadonlyMap<string, MemoryEntity>,
): MemoryWriteRelationHint[] {
  if (!Array.isArray(value)) return [];
  const hints = new Map<string, MemoryWriteRelationHint>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Partial<MemoryWriteRelationHint>;
    const fromKey = normalizedKey(raw.fromKey);
    const toKey = normalizedKey(raw.toKey);
    const type = typeof raw.type === 'string' && RELATION_TYPES.has(raw.type as MemoryRelationType)
      ? raw.type as MemoryRelationType
      : undefined;
    if (!fromKey || !toKey || fromKey === toKey || !type
      || !entities.has(fromKey) || !entities.has(toKey)) continue;
    hints.set(`${fromKey}\0${type}\0${toKey}`, { fromKey, toKey, type });
    if (hints.size >= MAX_RELATION_HINTS) break;
  }
  return [...hints.values()];
}

export function relationResolution(classification: ClassifiedMemoryStatement): MemoryResolutionStatus {
  if (classification.statementKind === 'suggestion' || classification.statementKind === 'hypothesis') {
    return 'proposed';
  }
  if (classification.assertedBy.kind === 'user') {
    if (classification.statementKind === 'decision' || classification.statementKind === 'approval') return 'resolved';
    if (SELF_AUTHORITATIVE_STATEMENTS.has(classification.statementKind)) return 'adopted';
    return 'unresolved';
  }
  if (classification.epistemicStatus === 'verified' || classification.epistemicStatus === 'corroborated') {
    return 'resolved';
  }
  return 'unresolved';
}

export function relationConfidence(classification: ClassifiedMemoryStatement): number {
  if (classification.epistemicStatus === 'verified') return 0.95;
  if (classification.epistemicStatus === 'corroborated') return 0.85;
  if (classification.epistemicStatus === 'disputed') return 0.2;
  if (classification.epistemicStatus === 'superseded') return 0;
  if (classification.assertedBy.kind === 'user'
    && SELF_AUTHORITATIVE_STATEMENTS.has(classification.statementKind)) return 0.9;
  if (classification.epistemicStatus === 'reported') return 0.55;
  return 0.35;
}

export function relationBaseRelevance(type: MemoryRelationType): number {
  if (type === 'depends-on' || type === 'supported-by' || type === 'replaces') return 0.8;
  if (type === 'conflicts-with') return 0.75;
  if (type === 'belongs-to' || type === 'derived-from') return 0.65;
  if (type === 'affects') return 0.6;
  if (type === 'references') return 0.55;
  return 0.45;
}

export function relationAuthorityScope(
  authority: AuthorityScope,
  scope: MemoryScope,
  storageScopeKey: string | undefined,
): AuthorityScope {
  if (authority.scope !== scope) return { kind: 'none', scope, scopeKey: storageScopeKey, topics: [] };
  return {
    kind: authority.kind,
    scope,
    scopeKey: scope === 'global' ? undefined : storageScopeKey,
    topics: uniqueStrings(authority.topics, 32),
  };
}

export function strongerAuthority(existing: AuthorityScope | undefined, candidate: AuthorityScope): AuthorityScope {
  if (!existing) return candidate;
  return authorityRank(candidate.kind) > authorityRank(existing.kind) ? candidate : existing;
}

export function strongerRelationResolution(
  existing: MemoryResolutionStatus,
  candidate: MemoryResolutionStatus,
): MemoryResolutionStatus {
  if (existing === 'rejected' || existing === 'superseded') return existing;
  const order: MemoryResolutionStatus[] = [
    'unresolved', 'proposed', 'under-review', 'adopted', 'resolved',
  ];
  return order.indexOf(candidate) > order.indexOf(existing) ? candidate : existing;
}

export function isActivationEligible(relation: MemoryRelation): boolean {
  return ACTIVATABLE_RESOLUTIONS.has(relation.resolutionStatus)
    && relation.authorityScope.kind !== 'none'
    && relation.confidence >= 0.55
    && (relation.sourceRefs.length > 0 || relation.evidenceRefs.length > 0);
}

export function assertEntityBoundary(entity: MemoryEntity, scope: MemoryScope, scopeKey: string | undefined): void {
  if (!sameScope(entity, scope, scopeKey)) {
    throw new Error(`Memory entity ${entity.id} crosses the write scope boundary.`);
  }
}

export function assertRelationBoundary(
  relation: MemoryRelation,
  scope: MemoryScope,
  scopeKey: string | undefined,
): void {
  if (!sameScope(relation, scope, scopeKey)) {
    throw new Error(`Memory relation ${relation.id} crosses the write scope boundary.`);
  }
}

export function sameScope(
  value: { scope: string; scopeKey?: string },
  scope: string,
  scopeKey: string | undefined,
): boolean {
  return value.scope === scope && (value.scopeKey ?? '') === (scopeKey ?? '');
}

export function relationEquivalent(left: MemoryRelation, right: MemoryRelation): boolean {
  return left.fromEntityId === right.fromEntityId
    && left.toEntityId === right.toEntityId
    && left.type === right.type
    && left.scope === right.scope
    && (left.scopeKey ?? '') === (right.scopeKey ?? '')
    && JSON.stringify(left.sourceRefs) === JSON.stringify(right.sourceRefs)
    && JSON.stringify(left.evidenceRefs) === JSON.stringify(right.evidenceRefs)
    && left.confidence === right.confidence
    && JSON.stringify(left.authorityScope) === JSON.stringify(right.authorityScope)
    && left.relevance === right.relevance
    && left.status === right.status
    && left.resolutionStatus === right.resolutionStatus;
}

export function uniqueStrings(values: readonly unknown[], limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = clean(value, 512);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function authorityRank(kind: AuthorityScope['kind']): number {
  if (kind === 'system-policy' || kind === 'tool-evidence') return 4;
  if (kind === 'user-self' || kind === 'project-owner' || kind === 'session-owner') return 3;
  if (kind === 'external-source') return 2;
  return 1;
}

function entityOwner(type: MemoryEntityType, actor: MemoryActorRef): MemoryActorRef {
  if (type === 'user') return { kind: 'user', id: actor.id ?? 'local-user', label: actor.label };
  if (['project', 'directory', 'file', 'session', 'task'].includes(type)) {
    return { kind: 'user', id: 'local-user' };
  }
  return structuredClone(actor);
}

function entityEquivalent(left: MemoryEntity, right: MemoryEntity): boolean {
  return left.type === right.type
    && left.scope === right.scope
    && (left.scopeKey ?? '') === (right.scopeKey ?? '')
    && (left.externalKey ?? '') === (right.externalKey ?? '')
    && left.label === right.label
    && JSON.stringify(left.aliases) === JSON.stringify(right.aliases)
    && JSON.stringify(left.owner) === JSON.stringify(right.owner)
    && left.status === right.status;
}

function normalizedKey(value: unknown): string | undefined {
  const text = clean(value, 160);
  return text?.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
}

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}
