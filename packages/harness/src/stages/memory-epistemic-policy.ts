// Converts model-described statement provenance into runtime-owned epistemic metadata.

import type {
  MemoryActorKind,
  MemoryActorRef,
  MemoryBranchKind,
  MemoryDomain,
  MemoryEntityType,
  MemoryRelationType,
  MemoryScope,
  MemoryWriteEntityHint,
  MemoryWriteEpistemicMetadata,
  MemoryWriteRelationHint,
  StatementKind,
} from '@littlesheep/memory-tree';

const DOMAINS = new Set<MemoryDomain>([
  'user', 'agent-self', 'task', 'project', 'session', 'experience', 'knowledge',
]);
const STATEMENT_KINDS = new Set<StatementKind>([
  'instruction', 'goal', 'preference', 'value', 'reported-observation',
  'factual-claim', 'suggestion', 'hypothesis', 'decision', 'approval',
]);
const MODEL_ACTORS = new Set<MemoryActorKind>(['user', 'agent', 'tool', 'external']);
const ENTITY_TYPES = new Set<MemoryEntityType>([
  'user', 'project', 'directory', 'file', 'session', 'task', 'skill', 'tool',
  'rule', 'concept', 'external-source',
]);
const RELATION_TYPES = new Set<MemoryRelationType>([
  'belongs-to', 'depends-on', 'references', 'conflicts-with', 'replaces',
  'derived-from', 'similar-to', 'affects', 'supported-by',
]);
const MAX_ENTITY_HINTS = 12;
const MAX_RELATION_HINTS = 16;

export interface ModelMemoryEpistemicProposal {
  domain?: unknown;
  statementKind?: unknown;
  assertedBy?: unknown;
  topics?: unknown;
  entities?: unknown;
  relations?: unknown;
}

export interface ResolveMemoryWriteEpistemicInput {
  raw?: unknown;
  stage: 'evolve' | 'capture';
  branch: MemoryBranchKind;
  scope: MemoryScope;
  scopeKey?: string;
  sourceRefs: string[];
  evidenceRefs: string[];
}

/**
 * The model may describe who made a statement and what kind of statement it is.
 * It may not declare truth, verification, or authority; those remain runtime-owned.
 */
export function resolveMemoryWriteEpistemic(
  input: ResolveMemoryWriteEpistemicInput,
): MemoryWriteEpistemicMetadata {
  const raw = record(input.raw);
  const statementKind = enumValue(raw?.statementKind, STATEMENT_KINDS)
    ?? (input.stage === 'capture' ? 'reported-observation' : 'factual-claim');
  const assertedBy = resolveActor(raw?.assertedBy, input.sourceRefs, input.evidenceRefs);
  const domain = resolveDomain(raw?.domain, input.branch, input.scope, assertedBy, statementKind);
  const epistemicStatus = resolveStatus(statementKind, assertedBy, input.stage, input.evidenceRefs);
  const entityHints = resolveEntityHints(raw?.entities);
  const relationHints = resolveRelationHints(raw?.relations, entityHints);
  const authorityScope = {
    kind: assertedBy.kind === 'user'
      ? 'user-self' as const
      : assertedBy.kind === 'tool'
        ? 'tool-evidence' as const
        : assertedBy.kind === 'external'
          ? 'external-source' as const
          : 'none' as const,
    scope: input.scope,
    scopeKey: input.scope === 'global' ? undefined : input.scopeKey,
    topics: stringArray(raw?.topics, 32, 80),
  };
  return {
    domain,
    statementKind,
    epistemicStatus,
    authorityScope,
    assertedBy,
    evidenceRefs: [...new Set(input.evidenceRefs)].slice(0, 64),
    ...(entityHints.length > 0 ? { entityHints } : {}),
    ...(relationHints.length > 0 ? { relationHints } : {}),
  };
}

function resolveEntityHints(value: unknown): MemoryWriteEntityHint[] {
  if (!Array.isArray(value)) return [];
  const selected = new Map<string, MemoryWriteEntityHint>();
  for (const item of value) {
    const raw = record(item);
    const stableKey = cleanEntityKey(raw?.stableKey);
    const type = enumValue(raw?.type, ENTITY_TYPES);
    const label = cleanString(raw?.label, 160);
    if (!stableKey || !type || !label) continue;
    const current = selected.get(stableKey);
    const aliases = stringArray(raw?.aliases, 8, 120);
    selected.set(stableKey, current
      ? { ...current, aliases: [...new Set([...(current.aliases ?? []), label, ...aliases])].slice(0, 8) }
      : { stableKey, type, label, ...(aliases.length > 0 ? { aliases } : {}) });
    if (selected.size >= MAX_ENTITY_HINTS) break;
  }
  return [...selected.values()];
}

function resolveRelationHints(
  value: unknown,
  entities: readonly MemoryWriteEntityHint[],
): MemoryWriteRelationHint[] {
  if (!Array.isArray(value) || entities.length === 0) return [];
  const entityKeys = new Set(entities.map((entity) => entity.stableKey));
  const selected = new Map<string, MemoryWriteRelationHint>();
  for (const item of value) {
    const raw = record(item);
    const fromKey = cleanEntityKey(raw?.fromKey);
    const toKey = cleanEntityKey(raw?.toKey);
    const type = enumValue(raw?.type, RELATION_TYPES);
    if (!fromKey || !toKey || fromKey === toKey || !type
      || !entityKeys.has(fromKey) || !entityKeys.has(toKey)) continue;
    const key = `${fromKey}\0${type}\0${toKey}`;
    selected.set(key, { fromKey, toKey, type });
    if (selected.size >= MAX_RELATION_HINTS) break;
  }
  return [...selected.values()];
}

function resolveActor(
  value: unknown,
  sourceRefs: readonly string[],
  evidenceRefs: readonly string[],
): MemoryActorRef {
  const raw = typeof value === 'string' ? { kind: value } : record(value);
  const requested = enumValue(raw?.kind, MODEL_ACTORS) ?? 'agent';
  const hasUserSource = sourceRefs.some((ref) => ref.includes(':user-message:'));
  const hasToolEvidence = evidenceRefs.some((ref) => ref.includes(':tool:') && ref.endsWith(':succeeded'));
  const hasExternalEvidence = evidenceRefs.some((ref) => /^(?:external|resource|url):/iu.test(ref));
  const kind: MemoryActorKind = requested === 'user' && !hasUserSource
    ? 'agent'
    : requested === 'tool' && !hasToolEvidence
      ? 'agent'
      : requested === 'external' && !hasExternalEvidence
        ? 'agent'
        : requested;
  const provenanceAccepted = kind === requested;
  return {
    kind,
    id: (provenanceAccepted ? cleanString(raw?.id, 120) : undefined) ?? defaultActorId(kind),
    label: provenanceAccepted ? cleanString(raw?.label, 120) : undefined,
  };
}

function resolveDomain(
  value: unknown,
  branch: MemoryBranchKind,
  scope: MemoryScope,
  actor: MemoryActorRef,
  statementKind: StatementKind,
): MemoryDomain {
  const requested = enumValue(value, DOMAINS);
  if (requested && domainCompatible(requested, branch, scope, actor)) return requested;
  if (actor.kind === 'user') return 'user';
  if (branch === 'project') return 'project';
  if (branch === 'experience') return 'experience';
  if (branch === 'daily') return scope === 'session' ? 'session' : 'task';
  if (actor.kind === 'agent' && (statementKind === 'value' || statementKind === 'instruction')) {
    return 'agent-self';
  }
  return 'knowledge';
}

function domainCompatible(
  domain: MemoryDomain,
  branch: MemoryBranchKind,
  scope: MemoryScope,
  actor: MemoryActorRef,
): boolean {
  if (domain === 'user') return actor.kind === 'user';
  if (domain === 'agent-self') return actor.kind === 'agent';
  if (domain === 'task') return branch === 'daily';
  if (domain === 'session') return branch === 'daily' && scope === 'session';
  if (domain === 'project') {
    return (branch === 'project' || branch === 'daily')
      && (scope === 'workspace' || scope === 'project');
  }
  if (domain === 'experience') return branch === 'experience' || branch === 'daily';
  return domain === 'knowledge' ? true : branch !== 'daily';
}

function resolveStatus(
  statementKind: StatementKind,
  actor: MemoryActorRef,
  stage: 'evolve' | 'capture',
  evidenceRefs: readonly string[],
): MemoryWriteEpistemicMetadata['epistemicStatus'] {
  if (statementKind === 'suggestion' || statementKind === 'hypothesis') return 'unverified';
  if (actor.kind === 'user') return 'reported';
  const hasToolEvidence = evidenceRefs.some((ref) => ref.includes(':tool:') && ref.endsWith(':succeeded'));
  const hasPassingVerification = evidenceRefs.some((ref) => ref.includes(':verification:') && ref.endsWith(':pass'));
  if (actor.kind === 'tool' && hasToolEvidence && hasPassingVerification) return 'corroborated';
  return stage === 'capture' ? 'reported' : 'unverified';
}

function defaultActorId(kind: MemoryActorKind): string | undefined {
  if (kind === 'user') return 'local-user';
  if (kind === 'agent') return 'littlesheep';
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : undefined;
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function cleanEntityKey(value: unknown): string | undefined {
  const cleaned = cleanString(value, 160);
  if (!cleaned) return undefined;
  return cleaned.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => cleanString(item, maxLength)?.toLocaleLowerCase())
    .filter((item): item is string => Boolean(item)))]
    .slice(0, maxItems);
}
