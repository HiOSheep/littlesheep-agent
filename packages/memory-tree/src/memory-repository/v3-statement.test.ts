import { describe, expect, it } from 'vitest';
import { InjectionTier, type MemoryWriteIntent } from '../types.js';
import { classifyMemoryWriteIntent, sameStatementCategory } from './v3-statement.js';

describe('Memory v3 statement classification', () => {
  it('uses explicit user suggestion metadata without promoting it to fact', () => {
    const result = classifyMemoryWriteIntent(intent({
      epistemic: {
        domain: 'user',
        statementKind: 'suggestion',
        epistemicStatus: 'unverified',
        authorityScope: { kind: 'user-self', scope: 'global', topics: ['architecture'] },
        assertedBy: { kind: 'user', id: 'local-user' },
      },
    }));
    expect(result).toMatchObject({
      domain: 'user',
      statementKind: 'suggestion',
      epistemicStatus: 'unverified',
      resolutionStatus: 'proposed',
      assertedBy: { kind: 'user', id: 'local-user' },
    });
  });

  it('conservatively distinguishes user preference, tool evidence, and agent suggestion', () => {
    expect(classifyMemoryWriteIntent(intent({
      summary: '用户偏好简洁回复',
      content: '用户明确表示希望进度更新简洁。',
    }))).toMatchObject({ domain: 'user', statementKind: 'preference', epistemicStatus: 'reported' });
    expect(classifyMemoryWriteIntent(intent({
      sourceStage: 'tool',
      summary: 'Package manager',
      content: 'package.json declares pnpm.',
    }))).toMatchObject({ statementKind: 'factual-claim', epistemicStatus: 'corroborated', assertedBy: { kind: 'tool' } });
    expect(classifyMemoryWriteIntent(intent({
      summary: 'Architecture proposal',
      content: '建议拆分这个模块。',
    }))).toMatchObject({ statementKind: 'suggestion', epistemicStatus: 'unverified', resolutionStatus: 'proposed' });
  });

  it('keeps merge categories separate', () => {
    const suggestion = classifyMemoryWriteIntent(intent({ content: '建议采用 SQLite。' }));
    const fact = classifyMemoryWriteIntent(intent({
      content: 'SQLite 已通过测试。',
      sourceStage: 'tool',
    }));
    expect(sameStatementCategory(suggestion, fact)).toBe(false);
  });
});

function intent(overrides: Partial<MemoryWriteIntent> = {}): MemoryWriteIntent {
  return {
    branch: 'long-term',
    parentNodeId: 'long-term:root',
    scope: 'global',
    tier: InjectionTier.T2_RELEVANT,
    summary: 'Memory statement',
    content: 'A durable statement.',
    retrievalKeys: ['statement'],
    sourceRunId: 'run-1',
    sourceStage: 'evolve',
    importance: 0.8,
    confidence: 0.8,
    reason: 'Test statement.',
    ...overrides,
  };
}
