import { describe, expect, it } from 'vitest';
import { scoreMemoryTaskRelevance } from './task-relevance.js';

describe('memory task relevance', () => {
  it('gives retrieval keys and titles more weight than incidental body matches', () => {
    const keyed = scoreMemoryTaskRelevance('aurora retention policy', {
      title: 'Retention rules',
      summary: 'Project cleanup policy.',
      searchKeys: ['aurora retention policy'],
    });
    const bodyOnly = scoreMemoryTaskRelevance('aurora retention policy', {
      title: 'Unrelated note',
      content: 'A log mentions the aurora retention policy once.',
    });

    expect(keyed.score).toBe(1);
    expect(keyed.strongestField).toBe('retrieval-key');
    expect(bodyOnly.score).toBeLessThan(keyed.score);
  });

  it('matches Chinese task phrases without treating request filler as evidence', () => {
    const related = scoreMemoryTaskRelevance('请帮我检查记忆注入策略', {
      title: '记忆注入策略',
      summary: '按任务相关性选择原子。',
      searchKeys: ['记忆注入', '原子选择'],
    });
    const unrelated = scoreMemoryTaskRelevance('请帮我检查记忆注入策略', {
      title: '桌面主题',
      summary: '深灰色界面配色。',
      searchKeys: ['界面', '颜色'],
    });

    expect(related.score).toBeGreaterThanOrEqual(0.6);
    expect(unrelated.score).toBe(0);
  });

  it('returns zero when only generic request terms remain', () => {
    expect(scoreMemoryTaskRelevance('please help me with this', {
      title: 'Any memory',
      summary: 'This should not be admitted merely because the request is vague.',
    }).score).toBe(0);
  });

  it('does not match a latin query term only because it is a substring of another word', () => {
    const result = scoreMemoryTaskRelevance('workplace and data root', {
      title: 'SQLite database recovery',
      summary: 'Recover a database file after a lock.',
      searchKeys: ['database', 'sqlite'],
    });

    expect(result.score).toBe(0);
  });

  it('keeps domain terms that merely begin with a common action word', () => {
    const result = scoreMemoryTaskRelevance('检查点恢复策略', {
      title: '检查点恢复策略',
      searchKeys: ['检查点恢复'],
    });

    expect(result.score).toBeGreaterThanOrEqual(0.9);
  });

  it('blocks content that the current task explicitly rejects', () => {
    const result = scoreMemoryTaskRelevance('不要旧方案，改用新的索引注入方案', {
      title: '旧方案',
      summary: '旧方案会把全部历史直接放入上下文。',
      searchKeys: ['旧方案', '全量历史'],
    });

    expect(result.score).toBe(0);
    expect(result.blockedByExclusion).toBe(true);
    expect(result.matchedExclusions).toEqual(['旧方案']);
  });

  it('keeps an explicit negative constraint about a rejected subject', () => {
    const result = scoreMemoryTaskRelevance('不要旧方案，改用新的索引注入方案', {
      title: '旧方案禁用决定',
      summary: '用户决定不再采用旧方案，应使用新的索引注入方案。',
      searchKeys: ['旧方案', '索引注入'],
    });

    expect(result.blockedByExclusion).toBe(false);
    expect(result.alignedExclusions).toEqual(['旧方案']);
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  it('does not mistake not-only phrasing for an exclusion', () => {
    const result = scoreMemoryTaskRelevance('not only memory files but also atom relevance', {
      title: 'Memory files and atom relevance',
      summary: 'Both storage and runtime routing are covered.',
    });

    expect(result.blockedByExclusion).toBe(false);
    expect(result.score).toBeGreaterThan(0);
  });
});
