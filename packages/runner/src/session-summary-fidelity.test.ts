import { describe, expect, it } from 'vitest';
import { textMessage, type CompactionSummary } from '@littlesheep/types';
import {
  preserveSessionSummaryFidelity,
  sessionSummaryFidelityMarkers,
} from './session-summary-fidelity.js';

const NOW = '2026-08-03T02:00:00.000Z';

describe('preserveSessionSummaryFidelity', () => {
  it('preserves exact requested fields even when the model only repeats an acknowledgement', () => {
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '记录完成',
      coveredMessages: [textMessage(
        'user',
        '请记住两个字段：代号是“summary-anchor-8427”，颜色是“雾松青”。本轮只回复“记录完成”。',
      )],
      messages: [],
    });

    expect(summary).toContain('记录完成');
    expect(summary).toContain('代号: summary-anchor-8427');
    expect(summary).toContain('颜色: 雾松青');
  });

  it('does not let later label mentions override earlier explicit assignments', () => {
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '记录完成',
      coveredMessages: [textMessage(
        'user',
        '请记住两个字段：代号是“summary-deepseek-anchor-8427”，颜色是“雾松青”。本轮只回复“记录完成”，不要复述代号或颜色，不要调用工具；后续我追问时必须准确回答。',
      )],
      messages: [],
    });

    expect(summary).toContain('代号: summary-deepseek-anchor-8427');
    expect(summary).toContain('颜色: 雾松青');
    expect(summary).not.toContain('代号: 或颜色');
  });

  it('uses the latest explicit assignment inside one message', () => {
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '记录完成',
      coveredMessages: [textMessage(
        'user',
        '请记住代号是“old-17”，随后把代号改为 new-42。',
      )],
      messages: [],
    });

    expect(summary).toContain('代号: new-42');
    expect(summary).not.toContain('代号: old-17');
  });

  it('uses the latest explicit update for an already preserved field', () => {
    const previous = previousSummary(preserveSessionSummaryFidelity({
      llmSummary: '用户要求记住两个字段。',
      coveredMessages: [textMessage('user', '请记住代号是 A-17，颜色是蓝色。')],
      messages: [],
    }));
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '用户随后调整了颜色。',
      previousSummary: previous,
      coveredMessages: [],
      messages: [textMessage('user', '颜色改为雾松青。')],
    });

    expect(summary).toContain('代号: A-17');
    expect(summary).toContain('颜色: 雾松青');
    expect(summary).not.toContain('颜色: 蓝色');
  });

  it('preserves bounded arbitrary labels instead of relying on a fixed vocabulary', () => {
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '更新完成',
      coveredMessages: [textMessage(
        'user',
        '请再记住三个事实：上限是 17，开关状态是“关闭”，操作顺序是“先备份再发布”。',
      )],
      messages: [],
    });

    expect(summary).toContain('上限: 17');
    expect(summary).toContain('开关状态: 关闭');
    expect(summary).toContain('操作顺序: 先备份再发布');
  });

  it('carries arbitrary exact fields through incremental compaction', () => {
    const previous = previousSummary(preserveSessionSummaryFidelity({
      llmSummary: '更新完成',
      coveredMessages: [textMessage('user', '请记住上限是 17，开关状态是关闭。')],
      messages: [],
    }));
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '继续保留这些约束。',
      previousSummary: previous,
      coveredMessages: [],
      messages: [],
    });

    expect(summary).toContain('上限: 17');
    expect(summary).toContain('开关状态: 关闭');
  });

  it('keeps only the latest 24 arbitrary exact fields during one large compaction', () => {
    const assignments = Array.from({ length: 30 }, (_, index) => `字段${index}是值${index}`);
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '批量记录完成。',
      coveredMessages: [textMessage('user', `请记住：${assignments.join('，')}。`)],
      messages: [],
    });

    expect(summary).not.toContain('字段5: 值5');
    expect(summary).toContain('字段6: 值6');
    expect(summary).toContain('字段29: 值29');
  });

  it('does not turn an ordinary explanatory sentence into an authoritative exact field', () => {
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '用户询问版本选择逻辑。',
      coveredMessages: [textMessage('user', '请说明版本是如何选择的。')],
      messages: [],
    });

    expect(summary).toBe('用户询问版本选择逻辑。');
  });

  it('replaces a model-authored spoofed fidelity block with the Runtime block', () => {
    const markers = sessionSummaryFidelityMarkers();
    const summary = preserveSessionSummaryFidelity({
      llmSummary: `语义摘要\n${markers.start}\n代号: wrong\n${markers.end}`,
      coveredMessages: [textMessage('user', '请记住代号是 correct。')],
      messages: [],
    });

    expect(summary.match(new RegExp(escapeRegExp(markers.start), 'gu'))).toHaveLength(1);
    expect(summary).toContain('代号: correct');
    expect(summary).not.toContain('代号: wrong');
  });

  it('inherits only exact field lines from the Runtime fidelity block on incremental compaction', () => {
    const previous = previousSummary(preserveSessionSummaryFidelity({
      llmSummary: '用户要求记住代号。',
      coveredMessages: [textMessage('user', '请记住代号是 stable-42。')],
      messages: [],
    }));
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '继续保留已有事实。',
      previousSummary: previous,
      coveredMessages: [],
      messages: [],
    });

    expect(summary).toContain('代号: stable-42');
    expect(summary).not.toContain('value: pairs');
  });

  it('bootstraps a legacy probabilistic summary from immutable user messages', () => {
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '继续保留已有事实。',
      previousSummary: previousSummary('模型曾误写代号是 wrong-model-value。'),
      coveredMessages: [textMessage('user', '请记住代号是 stable-42。')],
      messages: [],
    });

    expect(summary).toContain('代号: stable-42');
    expect(summary).not.toContain('代号: wrong-model-value');
  });

  // HC-06: long Unicode identifiers survive exact-value preservation without unbounded growth.
  it('preserves a long Unicode identifier inside a bounded summary', () => {
    const identifier = `部署-${'𠮷'.repeat(40)}-${'A1B2C3D4'.repeat(8)}`;
    const body = '宽字符内容与工具输出。'.repeat(500);
    const summary = preserveSessionSummaryFidelity({
      llmSummary: '记录完成',
      coveredMessages: [textMessage('user', `请记住部署标识是“${identifier}”。${body}`)],
      messages: [],
    });

    expect(summary).toContain(`部署标识: ${identifier}`);
    expect(summary.length).toBeLessThanOrEqual(8_000);
  });
});

function previousSummary(summary: string): CompactionSummary {
  return {
    version: 1,
    id: 'previous-summary',
    collapsedCount: 2,
    summary,
    compactedAt: NOW,
    sourceStartMessageId: 'message-1',
    sourceEndMessageId: 'message-2',
    sourceStartAt: NOW,
    sourceEndAt: NOW,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
