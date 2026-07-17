import { describe, expect, it } from 'vitest';
import { composeMemoryTaskQuery } from './task-query.js';

describe('memory task query composition', () => {
  it('uses bounded recent context only when the current request is genuinely referential', () => {
    const query = composeMemoryTaskQuery('继续处理它', [
      { role: 'user', content: '请优化 Memory v3 的 Atom 注入相关性。' },
      { role: 'assistant', content: '下一步会处理多轮指代和否定条件。' },
    ]);

    expect(query.historyUsed).toBe(true);
    expect(query.historyMessageCount).toBe(2);
    expect(query.retrievalText).toContain('Atom 注入相关性');
    expect(query.retrievalText).toContain('多轮指代和否定条件');
  });

  it('does not replay history for a self-contained request that merely uses a demonstrative', () => {
    const query = composeMemoryTaskQuery('这个项目的记忆注入需要按任务相关性排序', [
      { role: 'user', content: '旧话题是桌面配色。' },
      { role: 'assistant', content: '建议使用深灰色。' },
    ]);

    expect(query.historyUsed).toBe(false);
    expect(query.retrievalText).toContain('记忆注入');
    expect(query.retrievalText).not.toContain('桌面配色');
  });

  it('uses the recent assistant selection for an option reference', () => {
    const query = composeMemoryTaskQuery('按你刚才的第二个方案做', [
      { role: 'user', content: '怎样处理上下文膨胀？' },
      { role: 'assistant', content: '方案一是全量历史；方案二是有界索引导航。' },
    ]);

    expect(query.referenceKind).toBe('assistant-selection');
    expect(query.historyUsed).toBe(true);
    expect(query.retrievalText).toContain('有界索引导航');
  });

  it('resolves a short English pronoun without replaying unbounded history', () => {
    const query = composeMemoryTaskQuery('Continue with that.', [
      { role: 'user', content: 'Improve checkpoint recovery for long sessions.' },
      { role: 'assistant', content: 'The next step will make interrupted work resumable.' },
    ]);

    expect(query.historyUsed).toBe(true);
    expect(query.retrievalText).toContain('checkpoint recovery');
  });

  it('drops old context after an explicit task shift', () => {
    const query = composeMemoryTaskQuery('换个话题，检查拓展工作区动画', [
      { role: 'user', content: '继续调试记忆检索。' },
      { role: 'assistant', content: '正在检查 Atom 召回。' },
    ]);

    expect(query.taskShift).toBe(true);
    expect(query.historyUsed).toBe(false);
    expect(query.retrievalText).toContain('拓展工作区动画');
    expect(query.retrievalText).not.toContain('换个话题');
    expect(query.retrievalText).not.toContain('Atom 召回');
  });

  it('separates rejected subjects from the positive replacement', () => {
    const query = composeMemoryTaskQuery('不要旧方案，改用新的索引注入方案');

    expect(query.positiveText).toContain('新的索引注入方案');
    expect(query.excludedPhrases).toEqual(['旧方案']);
    expect(query.retrievalText).toContain('旧方案');
  });

  it('keeps a problem-to-prevent as positive task context instead of treating it as a rejected option', () => {
    const query = composeMemoryTaskQuery('怎样避免记忆上下文膨胀？');

    expect(query.excludedPhrases).toEqual([]);
    expect(query.positiveText).toContain('记忆上下文膨胀');
  });

  it('caps inherited history and ignores tool-like roles', () => {
    const query = composeMemoryTaskQuery('继续', [
      { role: 'user', content: `older-${'x'.repeat(1_000)}` },
      { role: 'tool', content: 'sensitive tool output' },
      { role: 'assistant', content: `assistant-${'y'.repeat(1_000)}` },
      { role: 'user', content: `latest-${'z'.repeat(1_000)}` },
    ], { maxHistoryChars: 120, maxHistoryMessages: 2, maxRetrievalChars: 200 });

    expect(query.historyMessageCount).toBeLessThanOrEqual(2);
    expect(query.retrievalText.length).toBeLessThanOrEqual(200);
    expect(query.retrievalText).not.toContain('sensitive tool output');
    expect(query.retrievalText).not.toContain('older-');
  });

  it('uses a bounded session summary only when recent referential history lacks a task anchor', () => {
    const query = composeMemoryTaskQuery('继续', [
      { role: 'assistant', content: '下一步继续执行。' },
    ], {}, {
      id: 'summary-1',
      content: '当前目标：完成 Aster checkpoint recovery 的跨重启恢复。下一步：验证恢复后的任务状态。',
    });

    expect(query.historyUsed).toBe(true);
    expect(query.summaryUsed).toBe(true);
    expect(query.continuitySummaryId).toBe('summary-1');
    expect(query.retrievalText).toContain('Aster checkpoint recovery');
  });

  it('treats generic English continuation wording as missing a task anchor', () => {
    const query = composeMemoryTaskQuery('Continue with that.', [
      { role: 'assistant', content: 'Ready for the next step.' },
    ], {}, {
      id: 'summary-routing',
      content: 'Current goal: finish Atom injection relevance routing. Next step: verify the context budget.',
    });

    expect(query.summaryUsed).toBe(true);
    expect(query.positiveSegments.some((segment) => segment.text === '.')).toBe(false);
    expect(query.retrievalText).toContain('Atom injection relevance routing');
  });

  it('does not add the session summary when recent history already names the task', () => {
    const query = composeMemoryTaskQuery('继续处理它', [
      { role: 'user', content: '请优化 Atom 注入相关性。' },
    ], {}, {
      id: 'stale-summary',
      content: '旧任务是修改深灰色界面。',
    });

    expect(query.summaryUsed).toBe(false);
    expect(query.retrievalText).not.toContain('深灰色界面');
  });

  it('never revives a summary after an explicit task shift', () => {
    const query = composeMemoryTaskQuery('换个话题，检查插件权限', [
      { role: 'assistant', content: '继续执行。' },
    ], {}, {
      id: 'summary-old-task',
      content: '当前目标：完成旧的记忆迁移任务。',
    });

    expect(query.summaryUsed).toBe(false);
    expect(query.retrievalText).toBe('检查插件权限');
  });

  it('normalizes optional action verbs inside hard exclusions', () => {
    const chinese = composeMemoryTaskQuery('不要使用旧方案，改用新方案');
    const english = composeMemoryTaskQuery('Do not use the old plan; use the new plan.');

    expect(chinese.excludedPhrases).toEqual(['旧方案']);
    expect(english.excludedPhrases).toEqual(['the old plan']);
  });
});
