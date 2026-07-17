import { describe, expect, it } from 'vitest';
import { InjectionTier, type MemoryWriteIntent } from '../types.js';
import { classifyMemoryWriteIntent } from './v3-statement.js';
import { atomIdForIntent, intentEvent, writeAudit } from './v3-node-transitions.js';

describe('Memory v3 repository write transitions', () => {
  it('builds byte-stable event and audit records for the same write retry', () => {
    const intent: MemoryWriteIntent = {
      id: 'maintenance:retryable-write',
      branch: 'project',
      parentNodeId: 'project:root',
      scope: 'workspace',
      scopeKey: 'D:/repo',
      tier: InjectionTier.T2_RELEVANT,
      summary: 'Retryable project decision',
      content: 'The same maintenance write can be safely resumed.',
      retrievalKeys: ['retryable', 'maintenance'],
      sourceRunId: 'run-1',
      sourceStage: 'maintenance',
      sourceRefs: ['conversation-source:run-1:user-message:message-1'],
      evidenceRefs: ['session-summary:summary-1'],
      importance: 0.8,
      confidence: 0.9,
      reason: 'Deterministic retry contract.',
      createdAt: '2026-07-17T00:00:00.000Z',
      epistemic: {
        domain: 'project',
        statementKind: 'decision',
        epistemicStatus: 'reported',
        authorityScope: { kind: 'user-self', scope: 'workspace', scopeKey: 'D:/repo', topics: [] },
        assertedBy: { kind: 'user', id: 'local-user' },
      },
    };
    const classification = classifyMemoryWriteIntent(intent);
    const atomId = atomIdForIntent(intent.id!);
    const auditA = writeAudit(intent, 'created', 'created', atomId);
    const auditB = writeAudit(intent, 'created', 'created', atomId);
    const eventA = intentEvent(intent, classification, 'scope-hash', 'created', auditA, atomId);
    const eventB = intentEvent(intent, classification, 'scope-hash', 'created', auditB, atomId);

    expect(auditB).toEqual(auditA);
    expect(eventB).toEqual(eventA);
    expect(eventA.id).toMatch(/^memory-event:[a-f0-9]{64}$/);
    expect(eventA.kind).toBe('resource-change');
  });
});
