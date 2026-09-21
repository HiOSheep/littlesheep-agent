import type { ContextMessageCandidate, ContextMessageSegment } from '@littlesheep/context';
import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import type {
  RunContext,
  RuntimeKnownStateMemoryReference,
  RuntimeMemoryKnownState,
  StageName,
} from '@littlesheep/types';
import { writeMemoryState } from './memory-state.js';

const MAX_STATE_REFERENCES = 128;
const MAX_PROMPT_REFERENCES = 12;

export function ingestMemoryKnownState(
  ctx: RunContext,
  value: unknown,
  stage: StageName,
): void {
  const incoming = parseKnownState(value, ctx.runId);
  if (!incoming) return;
  const current = ctx.memoryKnownState;
  const byAtom = new Map<string, RuntimeKnownStateMemoryReference>();
  for (const reference of current?.references ?? []) byAtom.set(reference.atomId, structuredClone(reference));
  for (const reference of incoming.references) {
    const existing = byAtom.get(reference.atomId);
    byAtom.set(reference.atomId, {
      ...structuredClone(reference),
      stages: [...new Set([...(existing?.stages ?? []), ...reference.stages, stage])],
      firstSeenAt: existing?.firstSeenAt ?? reference.firstSeenAt,
      reactivatedCount: Math.max(existing?.reactivatedCount ?? 0, reference.reactivatedCount),
    });
  }
  const references = [...byAtom.values()]
    .sort(compareReferences)
    .slice(0, MAX_STATE_REFERENCES);
  writeMemoryState(ctx, stage, {
    memoryKnownState: {
      version: 1,
      runId: ctx.runId,
      revision: Math.max(current?.revision ?? 0, incoming.revision) + 1,
      updatedAt: new Date().toISOString(),
      references,
    },
  });
}

export function markMemoryKnownStateStage(ctx: RunContext, stage: StageName): void {
  const state = ctx.memoryKnownState;
  if (!state) return;
  let changed = false;
  const references = state.references.map((reference) => {
    if (reference.stages.includes(stage)) return reference;
    changed = true;
    return { ...reference, stages: [...reference.stages, stage], updatedAt: new Date().toISOString() };
  });
  if (!changed) return;
  writeMemoryState(ctx, stage, {
    memoryKnownState: {
      ...state,
      revision: state.revision + 1,
      updatedAt: new Date().toISOString(),
      references,
    },
  });
}

export function injectMemoryKnownState(
  ctx: RunContext,
  stage: StageName,
  request: ChatRequest,
  candidates: ContextMessageCandidate[] | undefined,
  requestIndex: number,
): { request: ChatRequest; candidates?: ContextMessageCandidate[] } {
  const state = ctx.memoryKnownState;
  if (!state || state.references.length === 0) return { request, candidates };
  markMemoryKnownStateStage(ctx, stage);
  const current = ctx.memoryKnownState!;
  const original = request.messages.find((message) => message.role === 'system');
  if (!original) return { request, candidates };
  // Keep the per-request known state out of the system prompt: a change there
  // would cap the Provider's prefix cache at that byte and re-bill the whole
  // conversation. It travels in its own trailing message instead.
  //
  // This single-request path carries the rules inline because it has no tail
  // owner to emit them once; the main loop passes `includeRules: false` so its
  // interval slot holds the only copy.
  const segmentText = `${CACHE_BOUNDARY_MARKER}\n\n${renderKnownState(current, true)}`;
  const message: ChatMessage = { role: 'system', content: segmentText };
  const messages = [...request.messages, message];
  if (!candidates) return { request: { ...request, messages } };

  const segment: ContextMessageSegment = {
    id: `memory-known-state:${requestIndex}`,
    order: Number.MAX_SAFE_INTEGER - 1,
    text: segmentText,
    kind: 'memory_fragment',
    source: {
      kind: 'memory',
      id: `known-state:${ctx.runId}:${current.revision}`,
      runId: ctx.runId,
      generatedAt: current.updatedAt,
    },
    priority: 98,
    required: true,
    sensitive: true,
    scope: 'run',
  };
  return {
    request: { ...request, messages },
    candidates: [...candidates, {
      id: `memory-known-state:${requestIndex}`,
      order: Number.MAX_SAFE_INTEGER - 1,
      message,
      kind: 'memory_fragment',
      source: segment.source,
      priority: 98,
      required: true,
      sensitive: true,
      scope: 'run',
    }],
  };
}

/**
 * The exact KnownState text a request carries.
 *
 * Exported because the main loop appends KnownState changes as an append-only
 * tail event: the same bytes have to be produced from the same function, not
 * from a second copy of the rendering rules.
 */
export function renderKnownStateText(
  state: RuntimeMemoryKnownState,
  options: { includeRules?: boolean } = {},
): string {
  return `${CACHE_BOUNDARY_MARKER}\n\n${renderKnownState(state, options.includeRules !== false)}`;
}

/**
 * The reading rules for KnownState, as one stable section.
 *
 * They are policy, not state: identical in every entry and every run. Keeping
 * them inside each entry repeated 659 bytes, and — because the entry is
 * re-sent whenever a reference changes — paid that cost again on every memory
 * tool round. The section travels once, in the interval's stable tail.
 */
export function knownStateRulesSection(): string {
  return ['KnownState rules:', ...KNOWN_STATE_RULES].join('\n');
}

const KNOWN_STATE_RULES = [
  '- Use only adopted references as active evidence. Excluded references must not influence decisions unless a later retrieval explicitly reactivates them.',
  '- Conflicted references may explain uncertainty but cannot support a settled conclusion.',
  '- A suggestion or hypothesis can be considered or adopted as advice, but adoption never verifies it as fact.',
  '- Reported observations and unverified factual claims require corroboration before VERIFY or FINALIZE presents them as verified facts.',
  '- Respect authority scope and evidence refs. Do not infer cross-project, cross-session, ownership, identity, or causal relationships from similarity alone.',
];

function renderKnownState(state: RuntimeMemoryKnownState, includeRules: boolean): string {
  const references = [...state.references].sort(compareReferences).slice(0, MAX_PROMPT_REFERENCES);
  const lines = ['# Run Memory KnownState', ''];
  if (references.length < state.references.length) {
    // Only worth a line when it changes what the model can see; the absolute
    // revision counter is Runtime bookkeeping, not a judgement input, and
    // printing it made every memory tool round rewrite this whole entry.
    lines.push(
      '',
      `- references shown: ${references.length} of ${state.references.length} (most relevant first)`,
    );
  }
  for (const reference of references) {
    lines.push(...referenceLines(reference));
  }
  if (includeRules) lines.push('', knownStateRulesSection());
  return lines.join('\n');
}

/**
 * One reference, projected to the fields a model decision can depend on.
 *
 * Built as an explicit allowlist: Runtime bookkeeping and derived ranking
 * scores (revision counters, timestamps, first-seen, reactivation counts,
 * usefulness counters, task/routing/relationship/activation scores) stay in
 * Runtime data. They changed on rounds where nothing the model reads had
 * changed, and a changed entry is a re-sent entry. Adding a field to the
 * contract therefore cannot silently leak into the prompt.
 */
function referenceLines(reference: RuntimeKnownStateMemoryReference): string[] {
  const envelope = reference.envelope;
  const route = envelope.relationRoute;
  const scope = envelope.scopeKey
    ? `${envelope.scope}:${cleanInline(envelope.scopeKey)}`
    : envelope.scope;
  const fields = [
    `decision=${reference.decision}`,
    `disclosure=${envelope.disclosureLevel}`,
    `branch=${cleanInline(envelope.branch)}`,
    `scope=${cleanInline(scope)}`,
    `tier=T${envelope.tier}`,
  ];
  if (envelope.parentNodeId) fields.push(`parent=${cleanInline(envelope.parentNodeId)}`);
  fields.push(
    `statement=${cleanInline(envelope.statementKind)}`,
    `epistemic=${cleanInline(envelope.epistemicStatus)}`,
    `authority=${cleanInline(envelope.authorityScope.kind)}/${cleanInline(envelope.authorityScope.scope)}`,
    `confidence=${formatScore(envelope.confidence)}`,
    `importance=${formatScore(envelope.importance)}`,
    `path=${envelope.retrievalPath}`,
  );
  if (route) {
    fields.push(
      `relation_route=${cleanInline(`${route.seedAtomId}->${route.relationId}->${envelope.atomId} (${route.relationType}/${route.direction})`)}`,
    );
  }
  if (envelope.conflict) fields.push('conflict=true');
  if (envelope.expired) fields.push('expired=true');
  if (envelope.truncated) fields.push('truncated=true');

  const provenance = [`match=${cleanInline(envelope.matchReason)}`];
  if (reference.reason) provenance.push(`decision_reason=${cleanInline(reference.reason)}`);
  const sources = envelope.sourceRefs.slice(0, 3).map(cleanInline).join(', ');
  if (sources) provenance.push(`sources=${sources}`);
  const evidence = envelope.evidenceRefs.slice(0, 4).map(cleanInline).join(', ');
  if (evidence) provenance.push(`evidence=${evidence}`);

  return [
    `- [${reference.atomId}@${reference.atomRevision}] ${fields.join('; ')}`,
    `  ${provenance.join('; ')}`,
  ];
}

function parseKnownState(value: unknown, runId: string): RuntimeMemoryKnownState | undefined {
  if (!isRecord(value) || value.version !== 1 || value.runId !== runId
    || !Number.isInteger(value.revision) || typeof value.updatedAt !== 'string'
    || !Array.isArray(value.references)) return undefined;
  const references = value.references
    .map(parseReference)
    .filter((reference): reference is RuntimeKnownStateMemoryReference => Boolean(reference))
    .slice(0, MAX_STATE_REFERENCES);
  return {
    version: 1,
    runId,
    revision: Number(value.revision),
    updatedAt: value.updatedAt,
    references,
  };
}

function parseReference(value: unknown): RuntimeKnownStateMemoryReference | undefined {
  if (!isRecord(value) || typeof value.atomId !== 'string' || !Number.isInteger(value.atomRevision)
    || (value.sourceRefs !== undefined && !stringArray(value.sourceRefs)) || !stringArray(value.evidenceRefs)
    || !['adopted', 'excluded', 'conflicted'].includes(String(value.decision))
    || typeof value.reason !== 'string' || !isRecord(value.envelope) || !Array.isArray(value.stages)
    || typeof value.firstSeenAt !== 'string' || typeof value.updatedAt !== 'string'
    || !Number.isInteger(value.reactivatedCount) || Number(value.reactivatedCount) < 0
    || !stringArray(value.stages)) return undefined;
  const envelope = value.envelope;
  if (typeof envelope.atomId !== 'string' || !Number.isInteger(envelope.atomRevision)
    || typeof envelope.branch !== 'string' || typeof envelope.scope !== 'string'
    || (envelope.parentNodeId !== undefined && typeof envelope.parentNodeId !== 'string')
    || (envelope.scopeKey !== undefined && typeof envelope.scopeKey !== 'string')
    || !Number.isInteger(envelope.tier) || !['D0', 'D1', 'D2', 'D3'].includes(String(envelope.disclosureLevel))
    || typeof envelope.statementKind !== 'string' || typeof envelope.epistemicStatus !== 'string'
    || !isRecord(envelope.authorityScope) || !isRecord(envelope.assertedBy)
    || typeof envelope.authorityScope.kind !== 'string' || typeof envelope.authorityScope.scope !== 'string'
    || (envelope.authorityScope.scopeKey !== undefined && typeof envelope.authorityScope.scopeKey !== 'string')
    || !stringArray(envelope.authorityScope.topics) || typeof envelope.assertedBy.kind !== 'string'
    || (envelope.assertedBy.id !== undefined && typeof envelope.assertedBy.id !== 'string')
    || (envelope.assertedBy.label !== undefined && typeof envelope.assertedBy.label !== 'string')
    || (envelope.sourceRefs !== undefined && !stringArray(envelope.sourceRefs)) || !stringArray(envelope.evidenceRefs)
    || typeof envelope.confidence !== 'number'
    || typeof envelope.importance !== 'number' || typeof envelope.updatedAt !== 'string'
    || (envelope.verifiedUsefulness !== undefined && !isVerifiedUsefulness(envelope.verifiedUsefulness))
    || (envelope.lastVerifiedAt !== undefined && typeof envelope.lastVerifiedAt !== 'string')
    || !['hierarchy', 'fts', 'vector', 'relation'].includes(String(envelope.retrievalPath))
    || (envelope.relationRoute !== undefined && !isRelationRoute(envelope.relationRoute))
    || typeof envelope.matchReason !== 'string' || typeof envelope.conflict !== 'boolean'
    || typeof envelope.expired !== 'boolean' || typeof envelope.truncated !== 'boolean') return undefined;
  return {
    atomId: value.atomId,
    atomRevision: Number(value.atomRevision),
    sourceRefs: stringArray(value.sourceRefs) ? [...value.sourceRefs] : [],
    evidenceRefs: [...value.evidenceRefs],
    decision: value.decision as RuntimeKnownStateMemoryReference['decision'],
    reason: value.reason,
    envelope: {
      ...structuredClone(envelope),
      sourceRefs: stringArray(envelope.sourceRefs) ? [...envelope.sourceRefs] : [],
    } as unknown as RuntimeKnownStateMemoryReference['envelope'],
    stages: [...value.stages],
    firstSeenAt: value.firstSeenAt,
    updatedAt: value.updatedAt,
    reactivatedCount: Number(value.reactivatedCount),
  };
}

function isRelationRoute(value: unknown): boolean {
  return isRecord(value)
    && typeof value.seedAtomId === 'string'
    && typeof value.relationId === 'string'
    && typeof value.relationType === 'string'
    && ['outbound', 'inbound', 'shared'].includes(String(value.direction))
    && typeof value.confidence === 'number'
    && typeof value.relevance === 'number'
    && typeof value.strength === 'number';
}

function compareReferences(left: RuntimeKnownStateMemoryReference, right: RuntimeKnownStateMemoryReference): number {
  return decisionRank(right.decision) - decisionRank(left.decision)
    || left.envelope.tier - right.envelope.tier
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.atomId.localeCompare(right.atomId);
}

function decisionRank(value: RuntimeKnownStateMemoryReference['decision']): number {
  return value === 'conflicted' ? 3 : value === 'adopted' ? 2 : 1;
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)).toFixed(2) : '0.00';
}

function isVerifiedUsefulness(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ['useful', 'notUseful', 'conflicts', 'stale'].every((key) => (
    Number.isInteger(value[key]) && Number(value[key]) >= 0
  )) && (value.lastOutcome === undefined || typeof value.lastOutcome === 'string');
}

function cleanInline(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').trim().slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
