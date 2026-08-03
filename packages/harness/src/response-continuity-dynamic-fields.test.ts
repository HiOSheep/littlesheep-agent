import { describe, expect, it } from 'vitest';
import {
  continuityLabeledValues,
  continuityRequestedValueTargets,
} from './response-continuity-text.js';
import { collectRequestedValueEvidence } from './response-continuity-targets.js';
import {
  SESSION_SUMMARY_FIDELITY_END,
  SESSION_SUMMARY_FIDELITY_START,
} from './session-summary-fidelity-text.js';

describe('dynamic continuity fields', () => {
  it('extracts arbitrary explicit label/value assignments in source order', () => {
    expect(continuityLabeledValues(
      '请再记住三个事实：上限是 17，开关状态是“关闭”，操作顺序是“先备份再发布”。',
    )).toEqual(expect.arrayContaining([
      { label: '上限', value: '17' },
      { label: '开关状态', value: '关闭' },
      { label: '操作顺序', value: '先备份再发布' },
    ]));
  });

  it('requires complete English assignment words instead of splitting ordinary words', () => {
    expect(continuityLabeledValues('remember this request')).toEqual([]);
    expect(continuityLabeledValues('retry limit is 17')).toContainEqual({
      label: 'retry limit',
      value: '17',
    });
  });

  it('canonicalizes known aliases and bounds arbitrary fields before target expansion', () => {
    expect(continuityLabeledValues('请记住验收代号是 A-17。')).toContainEqual({
      label: '代号',
      value: 'A-17',
    });

    const assignments = Array.from({ length: 48 }, (_, index) => `字段${index}是值${index}`);
    const values = continuityLabeledValues(`请记住：${assignments.join('，')}。`);
    expect(values).toHaveLength(32);

    const targets = continuityRequestedValueTargets(
      `请回答${Array.from({ length: 48 }, (_, index) => `字段${index}`).join('、')}。`,
      [{ source: 'recent_history', texts: [`请记住：${assignments.join('，')}。`] }],
    );
    expect(targets).toHaveLength(32);
  });

  it('resolves requested arbitrary labels only from the Runtime fidelity envelope', () => {
    const summary = [
      '模型语义摘要没有复述具体值。',
      SESSION_SUMMARY_FIDELITY_START,
      '# Runtime-preserved exact fields',
      '上限: 17',
      '开关状态: 关闭',
      '操作顺序: 先备份再发布',
      SESSION_SUMMARY_FIDELITY_END,
    ].join('\n');
    const targets = continuityRequestedValueTargets(
      '请回答上限、开关状态和操作顺序。',
      [{ source: 'session_summary', texts: [summary] }],
    );

    expect(targets.map(({ label, value, source }) => ({ label, value, source }))).toEqual([
      { label: '上限', value: '17', source: 'session_summary' },
      { label: '开关状态', value: '关闭', source: 'session_summary' },
      { label: '操作顺序', value: '先备份再发布', source: 'session_summary' },
    ]);
  });

  it('discovers requested arbitrary labels from recent history without trusting summary prose', () => {
    const targets = continuityRequestedValueTargets(
      '请回答之前保存的上限和开关状态。',
      [
        {
          source: 'recent_history',
          texts: ['请记住：上限是 17，开关状态是关闭。'],
        },
        {
          source: 'session_summary',
          texts: ['概率摘要声称上限是 99，开关状态是开启，但没有 Runtime 保真封套。'],
        },
      ],
    );

    expect(targets.map(({ label, value, source }) => ({ label, value, source }))).toEqual([
      { label: '上限', value: '17', source: 'recent_history' },
      { label: '开关状态', value: '关闭', source: 'recent_history' },
    ]);
  });

  it('discovers requested arbitrary labels from an active memory Atom', () => {
    const targets = continuityRequestedValueTargets(
      '请回答记忆中的上限和开关状态。',
      [{
        source: 'active_memory_atom',
        texts: ['上限是 17，开关状态是关闭。'],
      }],
    );

    expect(targets.map(({ label, value, source }) => ({ label, value, source }))).toEqual([
      { label: '上限', value: '17', source: 'active_memory_atom' },
      { label: '开关状态', value: '关闭', source: 'active_memory_atom' },
    ]);
  });

  it('counts dynamic labels together with built-in labels for an all-fields verdict', () => {
    const summary = [
      '模型语义摘要没有复述具体值。',
      SESSION_SUMMARY_FIDELITY_START,
      '# Runtime-preserved exact fields',
      '代号: summary-deepseek-anchor-8427',
      '颜色: 雾松青',
      '上限: 17',
      '开关状态: 关闭',
      '操作顺序: 先备份再发布',
      SESSION_SUMMARY_FIDELITY_END,
    ].join('\n');
    const reply = '代号：summary-deepseek-anchor-8427；颜色：雾松青；上限：17；开关状态：关闭；操作顺序：先备份再发布。';
    const evidence = collectRequestedValueEvidence({
      enabled: true,
      request: '请分别回答最初保存的代号和颜色，以及后来约定的上限、开关状态和操作顺序。',
      reply,
      replyTerms: new Set([
        'summary-deepseek-anchor-8427',
        '雾松',
        '松青',
        '17',
        '关闭',
        '先备',
        '备份',
        '份再',
        '再发',
        '发布',
      ]),
      recentHistory: [],
      sessionSummaryIncluded: true,
      sessionSummaryText: summary,
      atomTexts: [],
      unscopedInitialText: '',
    });

    expect(evidence.requestedLabelCount).toBe(5);
    expect(evidence.matchedCount).toBe(5);
    expect(evidence.allMatched).toBe(true);
    expect(evidence.bySource.session_summary.allMatched).toBe(true);
  });
});
