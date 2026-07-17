import { describe, expect, it } from 'vitest';
import { resolveMemoryWriteEpistemic } from './memory-epistemic-policy.js';

const userSource = ['conversation-source:run-1:user-message:message-1'];
const verifiedToolEvidence = [
  'run:run-1:tool:tool-1:succeeded',
  'run:run-1:verification:1:pass',
];

describe('runtime-owned memory epistemic policy', () => {
  it('keeps a user suggestion unverified while preserving who suggested it', () => {
    expect(resolveMemoryWriteEpistemic({
      raw: {
        domain: 'user',
        statementKind: 'suggestion',
        assertedBy: { kind: 'user', id: 'local-user' },
        topics: ['Architecture', 'SQLite'],
      },
      stage: 'evolve',
      branch: 'long-term',
      scope: 'global',
      sourceRefs: userSource,
      evidenceRefs: verifiedToolEvidence,
    })).toMatchObject({
      domain: 'user',
      statementKind: 'suggestion',
      epistemicStatus: 'unverified',
      authorityScope: { kind: 'user-self', scope: 'global', topics: ['architecture', 'sqlite'] },
      assertedBy: { kind: 'user', id: 'local-user' },
    });
  });

  it('corroborates a tool claim only when successful tool and passing verification evidence exist', () => {
    expect(resolveMemoryWriteEpistemic({
      raw: {
        domain: 'project',
        statementKind: 'factual-claim',
        assertedBy: { kind: 'tool', id: 'package-inspector' },
      },
      stage: 'evolve',
      branch: 'project',
      scope: 'workspace',
      scopeKey: 'D:/repo',
      sourceRefs: userSource,
      evidenceRefs: verifiedToolEvidence,
    })).toMatchObject({
      domain: 'project',
      statementKind: 'factual-claim',
      epistemicStatus: 'corroborated',
      authorityScope: { kind: 'tool-evidence', scope: 'workspace', scopeKey: 'D:/repo' },
      assertedBy: { kind: 'tool', id: 'package-inspector' },
    });
  });

  it('downgrades unsupported source claims instead of trusting model-declared provenance', () => {
    expect(resolveMemoryWriteEpistemic({
      raw: {
        domain: 'project',
        statementKind: 'factual-claim',
        assertedBy: { kind: 'tool', id: 'missing-tool' },
      },
      stage: 'evolve',
      branch: 'project',
      scope: 'workspace',
      scopeKey: 'D:/repo',
      sourceRefs: userSource,
      evidenceRefs: ['run:run-1:verification:1:pass'],
    })).toMatchObject({
      domain: 'project',
      epistemicStatus: 'unverified',
      authorityScope: { kind: 'none' },
      assertedBy: { kind: 'agent', id: 'littlesheep' },
    });
  });

  it('uses conservative defaults when an older model response omits epistemic fields', () => {
    expect(resolveMemoryWriteEpistemic({
      stage: 'capture',
      branch: 'daily',
      scope: 'workspace',
      scopeKey: 'D:/repo',
      sourceRefs: userSource,
      evidenceRefs: [],
    })).toMatchObject({
      domain: 'task',
      statementKind: 'reported-observation',
      epistemicStatus: 'reported',
      authorityScope: { kind: 'none' },
      assertedBy: { kind: 'agent', id: 'littlesheep' },
    });
  });

  it('preserves a daily observation subject domain for later deterministic consolidation', () => {
    expect(resolveMemoryWriteEpistemic({
      raw: {
        domain: 'project',
        statementKind: 'factual-claim',
        assertedBy: { kind: 'tool', id: 'package-inspector' },
      },
      stage: 'capture',
      branch: 'daily',
      scope: 'workspace',
      scopeKey: 'D:/repo',
      sourceRefs: userSource,
      evidenceRefs: verifiedToolEvidence,
    })).toMatchObject({
      domain: 'project',
      epistemicStatus: 'corroborated',
      authorityScope: { kind: 'tool-evidence', scope: 'workspace', scopeKey: 'D:/repo' },
    });
  });

  it('keeps only bounded relations whose normalized endpoints were declared', () => {
    const resolved = resolveMemoryWriteEpistemic({
      raw: {
        domain: 'project',
        statementKind: 'decision',
        assertedBy: { kind: 'user', id: 'local-user' },
        entities: [
          { stableKey: ' Rule:Old ', type: 'rule', label: 'Old rule' },
          { stableKey: 'rule:new', type: 'rule', label: 'New rule', aliases: ['Replacement'] },
          { stableKey: 'rule:new', type: 'rule', label: 'New rule duplicate', aliases: ['Current'] },
          { stableKey: '', type: 'concept', label: 'Invalid' },
        ],
        relations: [
          { fromKey: 'RULE:NEW', toKey: 'rule:old', type: 'replaces' },
          { fromKey: 'rule:new', toKey: 'missing', type: 'depends-on' },
          { fromKey: 'rule:new', toKey: 'rule:new', type: 'similar-to' },
          { fromKey: 'rule:new', toKey: 'rule:old', type: 'replaces' },
        ],
      },
      stage: 'evolve',
      branch: 'project',
      scope: 'workspace',
      scopeKey: 'D:/repo',
      sourceRefs: userSource,
      evidenceRefs: [],
    });

    expect(resolved.entityHints).toEqual([
      { stableKey: 'rule:old', type: 'rule', label: 'Old rule' },
      {
        stableKey: 'rule:new',
        type: 'rule',
        label: 'New rule',
        aliases: ['replacement', 'New rule duplicate', 'current'],
      },
    ]);
    expect(resolved.relationHints).toEqual([
      { fromKey: 'rule:new', toKey: 'rule:old', type: 'replaces' },
    ]);
  });
});
