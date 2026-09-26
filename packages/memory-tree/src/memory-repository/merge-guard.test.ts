import { describe, expect, it } from 'vitest';
import {
  hasNegation,
  mayMergeMemoryStatements,
  memoryStatementValues,
} from './merge-guard.js';

const pair = (existingContent: string, incomingContent: string, extra: Partial<Parameters<typeof mayMergeMemoryStatements>[0]> = {}) => (
  mayMergeMemoryStatements({
    existingSummary: existingContent,
    existingContent,
    incomingSummary: incomingContent,
    incomingContent,
    ...extra,
  })
);

describe('memory merge guard', () => {
  it('refuses a merge when the values differ, however similar the wording', () => {
    const verdict = pair('数据库端口是 5432，用于本地开发。', '数据库端口是 6432，用于本地开发。');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('different-values');
  });

  it('reads values through grouping and unit spellings', () => {
    expect([...memoryStatementValues('5,432 次 or 1_000 ms')]).toEqual(['5432', '1000']);
    // The same value spelled the same way is not a difference.
    expect(pair('端口 5432', '端口 5432 用于开发').ok).toBe(true);
  });

  it('refuses a merge when only one side is negated', () => {
    expect(hasNegation('不要自动提交')).toBe(true);
    expect(hasNegation('never push to main')).toBe(true);
    expect(hasNegation('提交前先跑测试')).toBe(false);
    const verdict = pair('提交前先跑测试', '提交前不要跑测试');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('negation');
  });

  it('refuses a merge when the two statements are about different entities', () => {
    const verdict = pair('每周五部署', '每周五部署', {
      existingEntityRefs: ['project:alpha'],
      incomingEntityRefs: ['project:beta'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('different-entities');
    // Sharing an entity keeps the merge available, and so does having no entity information at all.
    expect(pair('每周五部署', '每周五部署', {
      existingEntityRefs: ['project:alpha'],
      incomingEntityRefs: ['project:alpha'],
    }).ok).toBe(true);
    expect(pair('每周五部署', '每周五部署', { existingEntityRefs: ['project:alpha'] }).ok).toBe(true);
  });

  it('allows a restatement of the same fact', () => {
    expect(pair('用户偏好简洁回复。', '用户偏好简洁的回复。').ok).toBe(true);
  });
});
