import type { ContextMessageCandidate, ContextMessageSegment } from '@littlesheep/context';
import type { ChatMessage, ChatRequest } from '@littlesheep/llm';
import { CACHE_BOUNDARY_MARKER } from '@littlesheep/prompt';
import type {
  RunContext,
  RuntimeKnownStateMemoryReference,
  RuntimeMemoryKnownState,
  StageName,
} from '@littlesheep/types';

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
  ctx.memoryKnownState = {
    version: 1,
    runId: ctx.runId,
    revision: Math.max(current?.revision ?? 0, incoming.revision) + 1,
    updatedAt: new Date().toISOString(),
    references,
  };
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
  ctx.memoryKnownState = {
    ...state,
    revision: state.revision + 1,
    updatedAt: new Date().toISOString(),
    references,
  };
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
  const systemIndex = request.messages.findIndex((message) => message.role === 'system');
  if (systemIndex < 0) return { request, candidates };
  const original = request.messages[systemIndex]!;
  const originalText = typeof original.content === 'string' ? original.content : undefined;
  const separator = originalText?.includes(CACHE_BOUNDARY_MARKER)
    ? '\n\n---\n\n'
    : `\n\n${CACHE_BOUNDARY_MARKER}\n\n`;
  const segmentText = `${separator}${renderKnownState(current)}`;
  const message = appendSystemText(original, segmentText);
  const messages = request.messages.map((candidate, index) => index === systemIndex ? message : candidate);
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
  const preparedCandidates = candidates.map((candidate) => {
    if (candidate.order !== systemIndex || candidate.message.role !== 'system') return candidate;
    if (candidate.segments) return { ...candidate, message, segments: [...candidate.segments, segment] };
    if (originalText !== undefined) {
      return {
        ...candidate,
        message,
        segments: [
          {
            id: `${candidate.id}:base`,
            order: 0,
            text: originalText,
            kind: candidate.kind,
            source: candidate.source,
            priority: candidate.priority,
            required: candidate.required,
            sensitive: candidate.sensitive,
            scope: candidate.scope,
          },
          segment,
        ],
      };
    }
    return { ...candidate, message };
  });
  return { request: { ...request, messages }, candidates: preparedCandidates };
}

function renderKnownState(state: RuntimeMemoryKnownState): string {
  const references = [...state.references].sort(compareReferences).slice(0, MAX_PROMPT_REFERENCES);
  const lines = [
    '# Run Memory KnownState',
    '',
    `- version: ${state.version}; revision: ${state.revision}; updated_at: ${state.updatedAt}`,
    `- references: ${references.length}/${state.references.length} shown`,
  ];
  for (const reference of references) {
    const envelope = reference.envelope;
    lines.push(
      `- [${reference.atomId}@${reference.atomRevision}] decision=${reference.decision}; disclosure=${envelope.disclosureLevel}; branch=${envelope.branch}; scope=${envelope.scope}${envelope.scopeKey ? `:${cleanInline(envelope.scopeKey)}` : ''}; tier=T${envelope.tier}`,
      `  parent=${envelope.parentNodeId ?? '(branch root)'}; statement=${envelope.statementKind}; epistemic=${envelope.epistemicStatus}; authority=${envelope.authorityScope.kind}/${envelope.authorityScope.scope}; confidence=${formatScore(envelope.confidence)}; importance=${formatScore(envelope.importance)}; usefulness=${formatUsefulness(envelope.verifiedUsefulness)}; task=${formatScore(envelope.taskRelevance ?? 0)}; routing=${formatScore(envelope.routingRelevance ?? 0.5)}; relation=${formatScore(envelope.relationshipRelevance ?? 0.5)}; activation=${formatScore(envelope.activation?.score ?? 0.25)}; path=${envelope.retrievalPath}${envelope.relationRoute ? `; relation_route=${cleanInline(`${envelope.relationRoute.seedAtomId}->${envelope.relationRoute.relationId}->${envelope.atomId} (${envelope.relationRoute.relationType}/${envelope.relationRoute.direction}; strength=${formatScore(envelope.relationRoute.strength)})`)}` : ''}`,
      `  match=${cleanInline(envelope.matchReason)}; decision_reason=${cleanInline(reference.reason)}; sources=${envelope.sourceRefs.slice(0, 3).map(cleanInline).join(', ') || '(none)'}; evidence=${envelope.evidenceRefs.slice(0, 4).map(cleanInline).join(', ') || '(none)'}; stages=${reference.stages.join(',')}; reactivated=${reference.reactivatedCount}`,
    );
  }
  lines.push(
    '',
    'KnownState rules:',
    '- Use only adopted references as active evidence. Excluded references must not influence decisions unless a later retrieval explicitly reactivates them.',
    '- Conflicted references may explain uncertainty but cannot support a settled conclusion.',
    '- A suggestion or hypothesis can be considered or adopted as advice, but adoption never verifies it as fact.',
    '- Reported observations and unverified factual claims require corroboration before VERIFY or FINALIZE presents them as verified facts.',
    '- Respect authority scope and evidence refs. Do not infer cross-project, cross-session, ownership, identity, or causal relationships from similarity alone.',
  );
  return lines.join('\n');
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

function appendSystemText(message: ChatMessage, suffix: string): ChatMessage {
  if (typeof message.content === 'string') return { ...message, content: `${message.content}${suffix}` };
  return { ...message, content: [...message.content, { type: 'text', text: suffix }] };
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

function formatUsefulness(value: RuntimeMemoryKnownState['references'][number]['envelope']['verifiedUsefulness']): string {
  if (!value) return 'unknown';
  return `${value.useful}/${value.notUseful + value.conflicts + value.stale}`;
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
