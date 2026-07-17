// JSON-safe run-level Memory v3 evidence contracts shared by Harness, Runner, logs, and UI.

import type { AtomicActivationSnapshot } from './activation.js';

export interface RuntimeMemoryAuthorityScope {
  kind: string;
  scope: string;
  scopeKey?: string;
  topics: string[];
}

export interface RuntimeMemoryActorRef {
  kind: string;
  id?: string;
  label?: string;
}

export interface RuntimeMemoryEvidenceEnvelope {
  atomId: string;
  atomRevision: number;
  branch: string;
  scope: string;
  scopeKey?: string;
  tier: number;
  disclosureLevel: 'D0' | 'D1' | 'D2' | 'D3';
  statementKind: string;
  epistemicStatus: string;
  authorityScope: RuntimeMemoryAuthorityScope;
  assertedBy: RuntimeMemoryActorRef;
  sourceRefs: string[];
  evidenceRefs: string[];
  confidence: number;
  importance: number;
  verifiedUsefulness?: {
    useful: number;
    notUseful: number;
    conflicts: number;
    stale: number;
    lastOutcome?: string;
  };
  taskRelevance?: number;
  routingRelevance?: number;
  relationshipRelevance?: number;
  activation?: AtomicActivationSnapshot;
  updatedAt: string;
  lastVerifiedAt?: string;
  retrievalPath: 'hierarchy' | 'fts' | 'vector' | 'relation';
  relationRoute?: {
    seedAtomId: string;
    relationId: string;
    relationType: string;
    direction: 'outbound' | 'inbound' | 'shared';
    confidence: number;
    relevance: number;
    strength: number;
  };
  matchReason: string;
  conflict: boolean;
  expired: boolean;
  truncated: boolean;
}

export interface RuntimeKnownStateMemoryReference {
  atomId: string;
  atomRevision: number;
  sourceRefs: string[];
  evidenceRefs: string[];
  decision: 'adopted' | 'excluded' | 'conflicted';
  reason: string;
  envelope: RuntimeMemoryEvidenceEnvelope;
  stages: string[];
  firstSeenAt: string;
  updatedAt: string;
  reactivatedCount: number;
}

export interface RuntimeMemoryKnownState {
  version: 1;
  runId: string;
  revision: number;
  updatedAt: string;
  references: RuntimeKnownStateMemoryReference[];
}
