import { z } from 'zod';
import { InjectionTier } from '../types.js';
import type {
  MemoryAtom,
  MemoryEventJournalRecord,
  MemoryOperationRecord,
  MemoryUpdateEvent,
  MemoryUseFeedback,
} from './contracts.js';

const nonEmpty = z.string().trim().min(1);
const conversationSourceRef = nonEmpty.regex(
  /^conversation-source:/u,
  'Memory sourceRefs must reference conversation source records.',
);
const timestamp = nonEmpty.refine((value) => Number.isFinite(Date.parse(value)), 'invalid timestamp');
const score = z.number().finite().min(0).max(1);
const nonNegativeInteger = z.number().int().min(0);
const scope = z.enum(['global', 'workspace', 'project', 'session']);
const actor = z.object({
  kind: z.enum(['user', 'agent', 'system', 'tool', 'external']),
  id: nonEmpty.optional(),
  label: nonEmpty.optional(),
}).strict();
const authority = z.object({
  kind: z.enum([
    'user-self',
    'system-policy',
    'project-owner',
    'session-owner',
    'tool-evidence',
    'external-source',
    'none',
  ]),
  scope: z.enum(['global', 'workspace', 'project', 'session', 'run']),
  scopeKey: nonEmpty.optional(),
  topics: z.array(nonEmpty).max(64),
}).strict();
const epistemicStatus = z.enum(['reported', 'unverified', 'corroborated', 'verified', 'disputed', 'superseded']);
const resolutionStatus = z.enum(['unresolved', 'proposed', 'under-review', 'adopted', 'rejected', 'resolved', 'superseded']);

const atomSchema = z.object({
  version: z.literal(3),
  id: nonEmpty.max(512),
  revision: z.number().int().min(1),
  domain: z.enum(['user', 'agent-self', 'task', 'project', 'session', 'experience', 'knowledge']),
  branch: z.enum(['long-term', 'daily', 'project', 'experience']),
  parentId: nonEmpty.max(512).optional(),
  scope,
  scopeKey: nonEmpty.max(2048).optional(),
  tier: z.nativeEnum(InjectionTier),
  statementKind: z.enum([
    'instruction',
    'goal',
    'preference',
    'value',
    'reported-observation',
    'factual-claim',
    'suggestion',
    'hypothesis',
    'decision',
    'approval',
  ]),
  epistemicStatus,
  authorityScope: authority,
  assertedBy: actor,
  sourceRefs: z.array(conversationSourceRef).max(256).default([]),
  evidenceRefs: z.array(nonEmpty).max(256),
  entityRefs: z.array(nonEmpty).max(256),
  relationRefs: z.array(nonEmpty).max(256),
  title: nonEmpty.max(500),
  summary: nonEmpty.max(8_000),
  content: z.string().max(2_000_000),
  retrievalKeys: z.array(nonEmpty.max(500)).max(256),
  importance: score,
  confidence: score,
  basePriority: score,
  verifiedUsefulness: z.object({
    useful: nonNegativeInteger,
    notUseful: nonNegativeInteger,
    conflicts: nonNegativeInteger,
    stale: nonNegativeInteger,
    lastOutcome: z.enum(['useful', 'not-useful', 'conflict', 'stale']).optional(),
  }).strict(),
  routingFeedback: z.object({
    useful: nonNegativeInteger,
    notUseful: nonNegativeInteger,
    conflicts: nonNegativeInteger,
    stale: nonNegativeInteger,
    effectiveRelevance: score.optional(),
    effectiveEvidenceWeight: z.number().finite().min(0).max(64).optional(),
    lastOutcome: z.enum(['useful', 'not-useful', 'conflict', 'stale']).optional(),
    lastRoutedAt: timestamp.optional(),
    recentFeedbackIds: z.array(nonEmpty.max(512)).max(64).optional(),
  }).strict().optional(),
  feedbackRevision: nonNegativeInteger,
  lastUsefulAt: timestamp.optional(),
  lastVerifiedAt: timestamp.optional(),
  reason: nonEmpty.max(8_000),
  sourceRunIds: z.array(nonEmpty).max(256),
  sourceStages: z.array(z.enum(['evolve', 'capture', 'tool', 'migration', 'maintenance'])).max(64),
  status: z.enum(['active', 'archived', 'tombstone']),
  resolutionStatus,
  invalidation: z.object({
    at: timestamp,
    reason: nonEmpty.max(8_000),
    priorEpistemicStatus: epistemicStatus,
    priorResolutionStatus: resolutionStatus,
  }).strict().nullable().optional(),
  merge: z.object({
    intoAtomId: nonEmpty.max(512),
    at: timestamp,
    reason: nonEmpty.max(8_000),
  }).strict().nullable().optional(),
  mergedFromAtomIds: z.array(nonEmpty.max(512)).max(256).optional(),
  mergedIntentIds: z.array(nonEmpty.max(512)).max(256).optional(),
  effectiveAt: timestamp.optional(),
  expiresAt: timestamp.optional(),
  revalidateAt: timestamp.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().superRefine((atom, ctx) => {
  if (atom.scope === 'global' && atom.scopeKey !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeKey'], message: 'global atoms cannot have scopeKey' });
  }
  if (atom.scope !== 'global' && atom.scopeKey === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeKey'], message: `${atom.scope} atoms require scopeKey` });
  }
  if (atom.parentId === atom.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['parentId'], message: 'atom cannot parent itself' });
  }
});

const updateEventSchema = z.object({
  version: z.literal(1),
  id: nonEmpty.max(512),
  idempotencyKey: nonEmpty.max(1024),
  kind: z.enum([
    'user-statement',
    'user-correction',
    'task-state',
    'tool-evidence',
    'verify-result',
    'resource-change',
    'agent-capability-change',
    'configuration-change',
    'conflict-resolution',
    'permission-decision',
    'time-due',
  ]),
  domain: z.enum(['user', 'agent-self', 'task', 'project', 'session', 'experience', 'knowledge']),
  scope,
  scopeKey: nonEmpty.max(2048).optional(),
  atomId: nonEmpty.max(512).optional(),
  expectedAtomRevision: z.number().int().min(1).optional(),
  source: actor,
  occurredAt: timestamp,
  observedAt: timestamp,
  sourceRefs: z.array(conversationSourceRef).max(256).default([]),
  evidenceRefs: z.array(nonEmpty).max(256),
  payload: z.record(z.unknown()),
}).strict().superRefine((event, ctx) => {
  if (event.scope === 'global' && event.scopeKey !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeKey'], message: 'global events cannot have scopeKey' });
  }
  if (event.scope !== 'global' && event.scopeKey === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeKey'], message: `${event.scope} events require scopeKey` });
  }
});

const eventRecordSchema = z.object({
  event: updateEventSchema,
  state: z.enum(['pending', 'committed', 'recovery']),
  attempts: nonNegativeInteger,
  operationId: nonEmpty.optional(),
  lastError: z.string().max(16_000).optional(),
  capturedAt: timestamp,
  updatedAt: timestamp,
}).strict();

const operationRecordSchema = z.object({
  version: z.literal(1),
  id: nonEmpty.max(512),
  idempotencyKey: nonEmpty.max(1024),
  kind: z.enum(['create', 'update', 'archive', 'restore', 'merge', 'rebuild']),
  atomIds: z.array(nonEmpty).max(1024),
  eventIds: z.array(nonEmpty).max(1024),
  expectedRevisions: z.record(z.number().int().min(0)),
  state: z.enum(['pending', 'committed', 'recovery']),
  attempts: nonNegativeInteger,
  lastError: z.string().max(16_000).optional(),
  startedAt: timestamp,
  updatedAt: timestamp,
  committedAt: timestamp.optional(),
}).strict();

export function parseMemoryAtom(value: unknown): MemoryAtom {
  return atomSchema.parse(value) as MemoryAtom;
}

export function parseMemoryUpdateEvent(value: unknown): MemoryUpdateEvent {
  return updateEventSchema.parse(value) as MemoryUpdateEvent;
}

export function parseMemoryEventJournalRecord(value: unknown): MemoryEventJournalRecord {
  return eventRecordSchema.parse(value) as MemoryEventJournalRecord;
}

export function parseMemoryOperationRecord(value: unknown): MemoryOperationRecord {
  return operationRecordSchema.parse(value) as MemoryOperationRecord;
}

export function validateMemoryUseFeedback(feedback: MemoryUseFeedback): void {
  if (!feedback.id.trim() || !feedback.atomId.trim() || !feedback.runId.trim()) {
    throw new Error('Memory feedback requires id, atomId, and runId.');
  }
  if (!Number.isFinite(Date.parse(feedback.createdAt))) {
    throw new Error('Memory feedback createdAt must be a valid timestamp.');
  }
  if (feedback.outcome === 'useful' && feedback.evidenceRefs.length === 0) {
    throw new Error('Positive memory feedback requires traceable use evidence.');
  }
}
