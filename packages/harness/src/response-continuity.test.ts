import { describe, expect, it } from 'vitest';
import { assessResponseMemoryContinuity } from './response-continuity.js';
import {
  textMessage,
  type ContextSnapshot,
  type ContextSnapshotItem,
  type ModelRequestSnapshot,
  type ReplyProvenance,
} from '@littlesheep/types';

const NOW = '2026-08-02T12:00:00.000Z';

const initialAtom = (atomId: string, content: string): string => [
  '# Initially Selected Memory Atoms',
  `<!-- littlesheep-memory-atom:start ${atomId} -->`,
  `## [${atomId}] T2 - selected`,
  content,
  `<!-- littlesheep-memory-atom:end ${atomId} -->`,
].join('\n');

const knownState = (atomId: string, decision: 'adopted' | 'excluded' = 'adopted') => ({
  version: 1 as const,
  runId: 'run-1',
  revision: 1,
  updatedAt: '2026-08-02T12:00:00.000Z',
  references: [{ atomId, decision } as never],
});

describe('assessResponseMemoryContinuity', () => {
  it('supports a reply that uses active adopted Atom details absent from the current request', () => {
    const assessment = assessResponseMemoryContinuity({
      reply: '已按你的长期偏好使用 pnpm，并在仓库根目录完成检查。',
      inbound: textMessage('user', '继续执行'),
      initialMemoryContext: initialAtom('atom-pnpm', '用户长期偏好使用 pnpm，默认工作区是仓库根目录。'),
      memoryKnownState: knownState('atom-pnpm'),
      memoryContextWorkingSet: {
        revision: 1,
        activeAtomIds: ['atom-pnpm'],
        releasedAtomIds: [],
        activeCallByAtom: { 'atom-pnpm': 'initial' },
        callAtomIds: { initial: ['atom-pnpm'] },
        updatedAt: '2026-08-02T12:00:00.000Z',
      },
      evaluatedAt: '2026-08-02T12:00:00.000Z',
    });

    expect(assessment.status).toBe('supported');
    expect(assessment.method).toBe('answer-evidence-v1');
    expect(assessment.matchedSources).toContain('active_memory_atom');
    expect(assessment.matchedAtomIds).toEqual(['atom-pnpm']);
    expect(assessment.evidence.memoryAnchorCount).toBeGreaterThanOrEqual(2);
    expect(assessment.evaluatedAt).toBe('2026-08-02T12:00:00.000Z');
  });

  it('supports continuity from recent conversation when the reply adds prior-turn details', () => {
    const priorUser = textMessage(
      'user',
      '请检查 LittleSheep 的项目工作区和记忆索引。',
      { id: 'history-user' },
    );
    const priorAssistant = textMessage(
      'assistant',
      '已经开始检查项目工作区。',
      { id: 'history-assistant' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续'),
      reply: '我会继续检查 LittleSheep 的项目工作区和记忆索引。',
      history: [priorUser, priorAssistant],
      ...observedContext([
        contextItem('history-user', 'recent_message', { kind: 'message', id: priorUser.id }),
        contextItem('history-assistant', 'recent_message', { kind: 'message', id: priorAssistant.id }),
      ]),
    });

    expect(assessment.status).toBe('supported');
    expect(assessment.sources.recentHistoryMessages).toBe(2);
    expect(assessment.matchedSources).toContain('recent_history');
    expect(assessment.evidence.historyAnchorCount).toBeGreaterThanOrEqual(2);
  });

  it('supports continuity from a session summary that entered the reply Context', () => {
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续'),
      reply: '继续完成浏览器跨重启恢复和后台长任务验收。',
      sessionSummary: {
        id: 'summary-1',
        summary: '尚未完成浏览器跨重启恢复和后台长任务验收。',
        collapsedCount: 8,
        compactedAt: NOW,
        sourceStartMessageId: 'message-1',
        sourceEndMessageId: 'message-8',
        sourceStartAt: NOW,
        sourceEndAt: NOW,
      },
      ...observedContext([
        contextItem(
          'summary-memory:summary-1',
          'summary_memory',
          { kind: 'memory', id: 'summary-1' },
        ),
      ]),
    });

    expect(assessment.status).toBe('supported');
    expect(assessment.matchedSources).toContain('session_summary');
    expect(assessment.evidence.summaryAnchorCount).toBeGreaterThanOrEqual(2);
  });

  it('treats a malformed null summary body as unavailable evidence instead of crashing the run', () => {
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续'),
      reply: '我会继续处理。',
      sessionSummary: {
        id: 'summary-null-body',
        summary: null,
      } as unknown as import('@littlesheep/types').CompactionSummary,
      ...observedContext([
        contextItem(
          'summary-memory:summary-null-body',
          'summary_memory',
          { kind: 'memory', id: 'summary-null-body' },
        ),
      ]),
    });

    expect(assessment.status).toBe('unavailable');
    expect(assessment.sources.sessionSummary).toBe(false);
    expect(assessment.missingSignals).toContain('continuation_target_not_available_for_comparison');
  });

  it('does not claim continuity from a history item omitted by the Context Engine', () => {
    const prior = textMessage(
      'user',
      '项目固定使用 pnpm，并从仓库根目录执行。',
      { id: 'history-omitted' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续'),
      reply: '继续使用 pnpm 并从仓库根目录执行。',
      history: [prior],
      ...observedContext([
        contextItem(
          'history-omitted',
          'recent_message',
          { kind: 'message', id: prior.id },
          'omitted',
        ),
      ]),
    });

    expect(assessment.status).toBe('unavailable');
    expect(assessment.sources.recentHistoryMessages).toBe(0);
    expect(assessment.matchedSources).not.toContain('recent_history');
    expect(assessment.missingSignals).toContain('continuation_target_not_available_for_comparison');
  });

  it('recognizes an active adopted Atom exposed through a memory tool result', () => {
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续推进'),
      reply: '这个大阶段完成后，我会推送 GitHub 并刷新快捷方式。',
      toolResults: [{
        callId: 'memory-call-1',
        ok: true,
        output: initialAtom('atom-release', '用户要求每个大阶段完成后推送 GitHub 并刷新快捷方式。'),
        meta: { memoryFragmentIds: ['atom-release'] },
      }],
      memoryKnownState: knownState('atom-release'),
      memoryContextWorkingSet: {
        revision: 1,
        activeAtomIds: ['atom-release'],
        releasedAtomIds: [],
        activeCallByAtom: { 'atom-release': 'memory-call-1' },
        callAtomIds: { 'memory-call-1': ['atom-release'] },
        updatedAt: NOW,
      },
      ...observedContext([
        contextItem('tool-memory-call-1', 'tool_result', { kind: 'tool', id: 'memory-call-1' }),
      ], 'execute_tool_loop'),
    });

    expect(assessment.status).toBe('supported');
    expect(assessment.matchedAtomIds).toEqual(['atom-release']);
    expect(assessment.sources.memoryToolResults).toBe(1);
    expect(assessment.matchedSignals).toContain('memory_tool_results_compared');
  });

  it('allows memory-derived TaskBook details to prove continuity', () => {
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续执行'),
      reply: '完成这个大阶段后会推送 GitHub 并刷新快捷方式。',
      taskBook: {
        goal: '完成当前大阶段后推送 GitHub 并刷新快捷方式',
        successCriteria: ['GitHub 已推送', '快捷方式已刷新'],
      } as never,
      initialMemoryContext: initialAtom(
        'atom-stage-release',
        '用户要求每个大阶段完成后推送 GitHub 并刷新快捷方式。',
      ),
      memoryKnownState: knownState('atom-stage-release'),
      memoryContextWorkingSet: {
        revision: 1,
        activeAtomIds: ['atom-stage-release'],
        releasedAtomIds: [],
        activeCallByAtom: { 'atom-stage-release': 'initial' },
        callAtomIds: { initial: ['atom-stage-release'] },
        updatedAt: NOW,
      },
      ...observedContext([
        contextItem(
          'initial-memory-selection',
          'memory_fragment',
          { kind: 'memory', id: 'initial-selection' },
        ),
      ], 'execute_final_reply'),
    });

    expect(assessment.status).toBe('supported');
    expect(assessment.matchedAtomIds).toEqual(['atom-stage-release']);
  });

  it('does not treat restating facts already present in the current request as memory continuity', () => {
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '请使用 pnpm 在仓库根目录检查项目。'),
      reply: '我会使用 pnpm 在仓库根目录检查项目。',
      initialMemoryContext: initialAtom('atom-pnpm', '用户偏好使用 pnpm，默认工作区是仓库根目录。'),
      memoryKnownState: knownState('atom-pnpm'),
      memoryContextWorkingSet: {
        revision: 1,
        activeAtomIds: ['atom-pnpm'],
        releasedAtomIds: [],
        activeCallByAtom: { 'atom-pnpm': 'initial' },
        callAtomIds: { initial: ['atom-pnpm'] },
        updatedAt: '2026-08-02T12:00:00.000Z',
      },
    });

    expect(assessment.status).toBe('uncertain');
    expect(assessment.matchedAtomIds).toEqual([]);
    expect(assessment.missingSignals).toContain('reply_only_matches_current_request');
  });

  it('does not credit a released or excluded Atom even when the reply repeats it', () => {
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续'),
      reply: '继续使用 pnpm 和仓库根目录。',
      initialMemoryContext: initialAtom('atom-pnpm', '用户偏好使用 pnpm，默认工作区是仓库根目录。'),
      memoryKnownState: knownState('atom-pnpm', 'excluded'),
      memoryContextWorkingSet: {
        revision: 2,
        activeAtomIds: [],
        releasedAtomIds: ['atom-pnpm'],
        activeCallByAtom: {},
        callAtomIds: { initial: ['atom-pnpm'] },
        updatedAt: '2026-08-02T12:00:01.000Z',
      },
    });

    expect(assessment.status).toBe('unavailable');
    expect(assessment.matchedAtomIds).toEqual([]);
  });

  it('reports uncertainty rather than claiming continuity without independent anchors', () => {
    const assessment = assessResponseMemoryContinuity({
      reply: '任务已经完成。',
      initialMemoryContext: '项目使用 pnpm，默认工作区是仓库根目录。',
    });

    expect(assessment.status).toBe('uncertain');
    expect(assessment.missingSignals).toContain('no_independent_active_memory_anchor');
  });

  it('reports a discontinuity when an explicit continuation reply drops observed prior details', () => {
    const prior = textMessage(
      'assistant',
      '下一步要验证 Electron 后台任务和跨重启检查点恢复。',
      { id: 'history-continuity-required' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续执行'),
      reply: '我已经处理好了。',
      history: [prior],
      ...observedContext([
        contextItem(
          'history-continuity-required',
          'recent_message',
          { kind: 'message', id: prior.id },
        ),
      ]),
    });

    expect(assessment.status).toBe('discontinuous');
    expect(assessment.sources.explicitContinuationRequest).toBe(true);
    expect(assessment.missingSignals).toContain('explicit_continuation_not_reflected_in_reply');
  });

  it('does not let an unrelated active Atom hide a dropped continuation target', () => {
    const prior = textMessage(
      'assistant',
      '下一步要验证 Electron 后台任务和跨重启检查点恢复。',
      { id: 'history-target-with-unrelated-memory' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续执行'),
      reply: '我会继续使用 pnpm 并从仓库根目录执行。',
      history: [prior],
      initialMemoryContext: initialAtom(
        'atom-pnpm-unrelated',
        '用户长期偏好使用 pnpm，默认工作区是仓库根目录。',
      ),
      memoryKnownState: knownState('atom-pnpm-unrelated'),
      memoryContextWorkingSet: {
        revision: 1,
        activeAtomIds: ['atom-pnpm-unrelated'],
        releasedAtomIds: [],
        activeCallByAtom: { 'atom-pnpm-unrelated': 'initial' },
        callAtomIds: { initial: ['atom-pnpm-unrelated'] },
        updatedAt: NOW,
      },
      ...observedContext([
        contextItem(
          'history-target-with-unrelated-memory',
          'recent_message',
          { kind: 'message', id: prior.id },
        ),
        contextItem(
          'initial-memory-selection',
          'memory_fragment',
          { kind: 'memory', id: 'initial-selection' },
        ),
      ]),
    });

    expect(assessment.status).toBe('discontinuous');
    expect(assessment.matchedSources).toContain('active_memory_atom');
    expect(assessment.matchedSources).not.toContain('recent_history');
  });

  it('does not call a reply continuous when it recalls an incidental restriction but omits the requested prior values', () => {
    const prior = textMessage(
      'user',
      '请记住代号 continuity-anchor-6824 和颜色琥珀色。仅本轮确认时不要复述，后续询问时必须原样回答。',
      { id: 'history-prior-values' },
    );
    const acknowledgement = textMessage(
      'assistant',
      '记录完成。',
      { id: 'history-prior-acknowledgement' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续上一轮。请输出上一轮让我保存的代号和颜色。'),
      reply: '我记得上一轮要求确认时不要复述，因此不会输出。请重新告诉我。',
      history: [prior, acknowledgement],
      ...observedContext([
        contextItem('history-prior-values', 'recent_message', { kind: 'message', id: prior.id }),
        contextItem(
          'history-prior-acknowledgement',
          'recent_message',
          { kind: 'message', id: acknowledgement.id },
        ),
      ]),
    });

    expect(assessment.status).toBe('discontinuous');
    expect(assessment.matchedSources).not.toContain('recent_history');
    expect(assessment.missingSignals).toContain('no_independent_recent_history_anchor');
    expect(assessment.missingSignals).toContain('explicit_continuation_not_reflected_in_reply');
  });

  it('supports an explicit recall only when the final answer contains every requested prior value', () => {
    const prior = textMessage(
      'user',
      '请记住代号 continuity-anchor-6824 和颜色琥珀色。',
      { id: 'history-complete-values' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续上一轮。请输出上一轮让我保存的代号和颜色。'),
      reply: '代号：continuity-anchor-6824；颜色：琥珀色。',
      history: [prior],
      ...observedContext([
        contextItem('history-complete-values', 'recent_message', { kind: 'message', id: prior.id }),
      ]),
    });

    expect(assessment.status).toBe('supported');
    expect(assessment.matchedSources).toContain('recent_history');
    expect(assessment.evidence.historyAnchorCount).toBeGreaterThanOrEqual(2);
    expect(assessment.missingSignals).not.toContain('explicit_continuation_not_reflected_in_reply');
  });

  it('treats a direct memory question without the word continue as an explicit continuity check', () => {
    const prior = textMessage(
      'user',
      '请记住代号 continuity-anchor-6824 和颜色琥珀色。',
      { id: 'history-direct-recall' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '你还记得我上次说的代号和颜色吗？'),
      reply: '代号是 continuity-anchor-6824，颜色是琥珀色。',
      history: [prior],
      ...observedContext([
        contextItem('history-direct-recall', 'recent_message', { kind: 'message', id: prior.id }),
      ]),
    });

    expect(assessment.sources.explicitContinuationRequest).toBe(true);
    expect(assessment.status).toBe('supported');
    expect(assessment.matchedSources).toContain('recent_history');
  });

  it('judges a real Chinese Markdown recall from the final answer instead of formatting noise', () => {
    const prior = textMessage(
      'assistant',
      [
        '任务已完成。',
        '- **文件名称**：`background-proof.txt`',
        '- **验收代号**：`deepseek-background-anchor-7319`',
      ].join('\n'),
      { id: 'history-deepseek-markdown-values' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage(
        'user',
        '你还记得上一轮保存的文件名称和验收代号吗？请分别回答，不要调用工具。',
      ),
      reply: [
        '是的，记得：',
        '',
        '- **文件名称**：`background-proof.txt`',
        '- **验收代号**：`deepseek-background-anchor-7319`',
        '',
        '未调用任何工具。',
      ].join('\n'),
      history: [prior],
      ...observedContext([
        contextItem(
          'history-deepseek-markdown-values',
          'recent_message',
          { kind: 'message', id: prior.id },
        ),
      ]),
    });

    expect(assessment.sources.explicitContinuationRequest).toBe(true);
    expect(assessment.status).toBe('supported');
    expect(assessment.matchedSources).toContain('recent_history');
    expect(assessment.evidence.historyAnchorCount).toBeGreaterThanOrEqual(2);
    expect(assessment.missingSignals).not.toContain('explicit_continuation_not_reflected_in_reply');
  });

  it('uses an included versioned summary for explicit value recall when recent history has no value', () => {
    const acknowledgement = textMessage(
      'assistant',
      '代号和颜色都已记录完成。',
      { id: 'history-summary-acknowledgement' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '你还记得我上次说的代号和颜色吗？'),
      reply: '代号是 summary-anchor-27，颜色是海蓝色。',
      history: [acknowledgement],
      sessionSummary: {
        id: 'summary-explicit-values',
        summary: '用户要求保存的代号为 summary-anchor-27，颜色为海蓝色。',
        collapsedCount: 6,
        compactedAt: NOW,
        sourceStartMessageId: 'message-1',
        sourceEndMessageId: 'message-6',
        sourceStartAt: NOW,
        sourceEndAt: NOW,
      },
      ...observedContext([
        contextItem(
          'summary-memory:summary-explicit-values',
          'summary_memory',
          { kind: 'memory', id: 'summary-explicit-values' },
        ),
        contextItem(
          'history-summary-acknowledgement',
          'recent_message',
          { kind: 'message', id: acknowledgement.id },
        ),
      ]),
    });

    expect(assessment.status).toBe('supported');
    expect(assessment.matchedSources).toContain('session_summary');
    expect(assessment.matchedSources).not.toContain('recent_history');
  });

  it('uses an active adopted Atom for explicit value recall after the original turn is absent', () => {
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '你还记得我之前说的代号和颜色吗？'),
      reply: '代号是 atom-anchor-91，颜色是青绿色。',
      initialMemoryContext: initialAtom(
        'atom-explicit-values',
        '用户要求保存的代号为 atom-anchor-91，颜色为青绿色。',
      ),
      memoryKnownState: knownState('atom-explicit-values'),
      memoryContextWorkingSet: {
        revision: 1,
        activeAtomIds: ['atom-explicit-values'],
        releasedAtomIds: [],
        activeCallByAtom: { 'atom-explicit-values': 'initial' },
        callAtomIds: { initial: ['atom-explicit-values'] },
        updatedAt: NOW,
      },
      ...observedContext([
        contextItem(
          'initial-memory-selection',
          'memory_fragment',
          { kind: 'memory', id: 'initial-selection' },
        ),
      ]),
    });

    expect(assessment.status).toBe('supported');
    expect(assessment.matchedSources).toContain('active_memory_atom');
    expect(assessment.matchedAtomIds).toEqual(['atom-explicit-values']);
  });

  it('reports a discontinuity when an explicit multi-value recall answers only one requested value', () => {
    const prior = textMessage(
      'user',
      '请记住代号 continuity-anchor-6824 和颜色琥珀色。',
      { id: 'history-partial-values' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续上一轮。请输出上一轮让我保存的代号和颜色。'),
      reply: '代号：continuity-anchor-6824；颜色我不记得了。',
      history: [prior],
      ...observedContext([
        contextItem('history-partial-values', 'recent_message', { kind: 'message', id: prior.id }),
      ]),
    });

    expect(assessment.status).toBe('discontinuous');
    expect(assessment.matchedSources).not.toContain('recent_history');
    expect(assessment.evidence.historyAnchorCount).toBeGreaterThan(0);
    expect(assessment.missingSignals).toContain('explicit_continuation_not_reflected_in_reply');
  });

  it('does not treat prior values mentioned only in a denial as a continuous answer', () => {
    const prior = textMessage(
      'user',
      '请记住代号 continuity-anchor-6824 和颜色琥珀色。',
      { id: 'history-negated-values' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '你还记得我上次说的代号和颜色吗？'),
      reply: '代号不是 continuity-anchor-6824，颜色也不是琥珀色。',
      history: [prior],
      ...observedContext([
        contextItem('history-negated-values', 'recent_message', { kind: 'message', id: prior.id }),
      ]),
    });

    expect(assessment.status).toBe('discontinuous');
    expect(assessment.matchedSources).not.toContain('recent_history');
    expect(assessment.missingSignals).toContain('explicit_continuation_not_reflected_in_reply');
  });

  it('does not pass continuity when the reply repeats every value but explicitly claims amnesia', () => {
    const prior = textMessage(
      'user',
      'Remember code continuity-anchor-6824 and color amber.',
      { id: 'history-values-with-amnesia' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', 'Do you remember the code and color from the previous turn?'),
      reply: 'I cannot remember the previous turn, but the code was continuity-anchor-6824 and the color was amber.',
      history: [prior],
      ...observedContext([
        contextItem(
          'history-values-with-amnesia',
          'recent_message',
          { kind: 'message', id: prior.id },
        ),
      ]),
    });

    expect(assessment.status).toBe('discontinuous');
    expect(assessment.matchedSources).not.toContain('recent_history');
    expect(assessment.missingSignals).toContain('explicit_continuation_not_reflected_in_reply');
  });

  it('uses an explicit memory failure in the final reply as discontinuity evidence', () => {
    const prior = textMessage(
      'assistant',
      '下一步要验证 Electron 后台任务和跨重启检查点恢复。',
      { id: 'history-explicit-amnesia' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续执行'),
      reply: '我无法回忆上一轮的具体目标，请重新告诉我。',
      history: [prior],
      ...observedContext([
        contextItem('history-explicit-amnesia', 'recent_message', { kind: 'message', id: prior.id }),
      ]),
    });

    expect(assessment.status).toBe('discontinuous');
    expect(assessment.matchedSources).not.toContain('recent_history');
    expect(assessment.missingSignals).toContain('explicit_continuation_not_reflected_in_reply');
  });

  it('does not claim amnesia when no previous task target is available to compare', () => {
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续执行'),
      reply: '我会继续处理。',
    });

    expect(assessment.status).toBe('unavailable');
    expect(assessment.sources.explicitContinuationRequest).toBe(true);
    expect(assessment.missingSignals).toContain('continuation_target_not_available_for_comparison');
  });

  it('keeps a weakly paraphrased continuation uncertain instead of declaring amnesia', () => {
    const prior = textMessage(
      'assistant',
      '下一步要验证 Electron 后台任务和跨重启检查点恢复。',
      { id: 'history-weak-continuity' },
    );
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续执行'),
      reply: '我会先处理 Electron。',
      history: [prior],
      ...observedContext([
        contextItem(
          'history-weak-continuity',
          'recent_message',
          { kind: 'message', id: prior.id },
        ),
      ]),
    });

    expect(assessment.status).toBe('uncertain');
    expect(assessment.evidence.historyAnchorCount).toBe(1);
    expect(assessment.missingSignals).not.toContain('explicit_continuation_not_reflected_in_reply');
  });

  it('keeps an explicit continuation uncertain when Context observability is truncated', () => {
    const prior = textMessage(
      'assistant',
      '下一步要验证 Electron 后台任务和跨重启检查点恢复。',
      { id: 'history-truncated' },
    );
    const observed = observedContext([
      contextItem('history-truncated', 'recent_message', { kind: 'message', id: prior.id }),
    ]);
    observed.contextSnapshots[0]!.itemsTruncated = true;
    const assessment = assessResponseMemoryContinuity({
      inbound: textMessage('user', '继续执行'),
      reply: '我已经处理好了。',
      history: [prior],
      ...observed,
    });

    expect(assessment.status).toBe('uncertain');
    expect(assessment.missingSignals).toContain('context_observability_truncated');
  });

  it('reports not_applicable when there is no prior evidence', () => {
    const assessment = assessResponseMemoryContinuity({ reply: '你好。' });

    expect(assessment.status).toBe('not_applicable');
    expect(assessment.matchedSignals).toContain('no_prior_memory_or_conversation_evidence');
  });

  it('reports unavailable when memory metadata exists but its text is absent', () => {
    const assessment = assessResponseMemoryContinuity({
      reply: '我会继续处理这个任务。',
      memoryKnownState: knownState('atom-1'),
    });

    expect(assessment.status).toBe('unavailable');
    expect(assessment.missingSignals).toContain('memory_text_not_available_for_reply_comparison');
    expect(assessment.referencedAtomIds).toEqual(['atom-1']);
  });

  it('reports unavailable when reply provenance has no matching Context snapshot', () => {
    const observed = observedContext([]);
    const assessment = assessResponseMemoryContinuity({
      reply: '继续处理。',
      replyProvenance: observed.replyProvenance,
      modelRequests: observed.modelRequests,
      contextSnapshots: [],
    });

    expect(assessment.status).toBe('unavailable');
    expect(assessment.missingSignals).toContain('reply_context_observability_unavailable');
  });
});

function observedContext(
  items: ContextSnapshotItem[],
  purpose: ReplyProvenance['purpose'] = 'reply',
): {
  replyProvenance: ReplyProvenance;
  modelRequests: ModelRequestSnapshot[];
  contextSnapshots: ContextSnapshot[];
} {
  const replyProvenance: ReplyProvenance = {
    version: 1,
    source: 'llm',
    purpose,
    modelRequestId: 'request-1',
    modelRequestIndex: 1,
    provider: 'test-provider',
    model: 'test-model',
    generatedAt: NOW,
    rewriteCount: 0,
  };
  return {
    replyProvenance,
    modelRequests: [{
      version: 1,
      id: replyProvenance.modelRequestId,
      runId: 'run-1',
      sessionId: 'session-1' as never,
      stage: purpose === 'reply' ? 'reply' : purpose === 'recover' ? 'recover' : 'execute',
      requestIndex: 1,
      provider: replyProvenance.provider,
      model: replyProvenance.model,
      createdAt: NOW,
      messages: [],
      totalMessageCount: 0,
      messagesTruncated: false,
      toolNames: [],
      totalToolCount: 0,
      toolsTruncated: false,
      stream: false,
      callContract: { purpose } as never,
      contextSnapshotId: 'context-1',
    }],
    contextSnapshots: [{
      version: 1,
      id: 'context-1',
      runId: 'run-1',
      sessionId: 'session-1' as never,
      provider: replyProvenance.provider,
      model: replyProvenance.model,
      createdAt: NOW,
      budget: { status: 'unknown', reason: 'unit test' },
      items,
      totalItemCount: items.length,
      itemsTruncated: false,
      compressionRecommended: false,
    }],
  };
}

function contextItem(
  id: string,
  kind: ContextSnapshotItem['kind'],
  source: ContextSnapshotItem['source'],
  disposition: ContextSnapshotItem['disposition'] = 'included',
): ContextSnapshotItem {
  return {
    id,
    kind,
    scope: 'run',
    source,
    priority: 80,
    required: false,
    sensitive: true,
    createdAt: NOW,
    contentType: 'text',
    disposition,
    omissionReason: disposition === 'omitted' ? 'budget' : undefined,
  };
}
