import { InjectionTier } from '../types.js';
import type { CreateMemoryAtomInput, MemoryAtom } from './contracts.js';
import { memoryAtomContentHash } from './atom-store.js';

export const TEST_TIME = '2026-07-15T04:00:00.000Z';

export function makeAtomInput(overrides: Partial<CreateMemoryAtomInput> = {}): CreateMemoryAtomInput {
  return {
    id: 'atom-root',
    domain: 'project',
    branch: 'project',
    scope: 'project',
    scopeKey: 'project-a',
    tier: InjectionTier.T2_RELEVANT,
    statementKind: 'factual-claim',
    epistemicStatus: 'verified',
    authorityScope: { kind: 'tool-evidence', scope: 'project', scopeKey: 'project-a', topics: ['repository'] },
    assertedBy: { kind: 'tool', id: 'test-tool' },
    sourceRefs: ['conversation-source:run-test:user-message:user-1'],
    evidenceRefs: ['tool:test'],
    entityRefs: [],
    relationRefs: [],
    title: 'Project root',
    summary: 'Verified project memory root.',
    content: 'The project uses a local memory catalog.',
    retrievalKeys: ['project', 'memory', 'catalog'],
    importance: 0.8,
    confidence: 0.9,
    basePriority: 0.7,
    verifiedUsefulness: { useful: 1, notUseful: 0, conflicts: 0, stale: 0, lastOutcome: 'useful' },
    routingFeedback: {
      useful: 1,
      notUseful: 0,
      conflicts: 0,
      stale: 0,
      lastOutcome: 'useful',
      lastRoutedAt: TEST_TIME,
      recentFeedbackIds: [],
    },
    feedbackRevision: 1,
    lastUsefulAt: TEST_TIME,
    lastVerifiedAt: TEST_TIME,
    reason: 'Test fixture.',
    sourceRunIds: ['run-test'],
    sourceStages: ['tool'],
    status: 'active',
    resolutionStatus: 'resolved',
    createdAt: TEST_TIME,
    updatedAt: TEST_TIME,
    ...overrides,
  };
}

export function makeStoredAtom(overrides: Partial<CreateMemoryAtomInput> = {}): MemoryAtom {
  const input = makeAtomInput(overrides);
  const withoutHash: Omit<MemoryAtom, 'contentHash'> = {
    ...input,
    version: 3,
    revision: 1,
    createdAt: input.createdAt ?? TEST_TIME,
    updatedAt: input.updatedAt ?? TEST_TIME,
  };
  return { ...withoutHash, contentHash: memoryAtomContentHash(withoutHash) };
}
