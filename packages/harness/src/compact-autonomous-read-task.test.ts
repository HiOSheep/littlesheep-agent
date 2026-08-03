import { describe, expect, it } from 'vitest';
import { textMessage, type RuntimeMemoryKnownState, type TaskBook } from '@littlesheep/types';
import { makeCtx, makeTool } from './tests/helpers.js';
import {
  resolveCompactAutonomousReadDecisionTools,
  resolveCompactAutonomousReadExecutionTools,
} from './compact-autonomous-read-task.js';

describe('compact autonomous read task', () => {
  it('offers a small builtin catalog for a self-contained read-only goal', () => {
    const ctx = context('请查看当前工作区顶层有哪些条目，只告诉我数量和名称，不要修改任何文件。');
    expect(resolveCompactAutonomousReadDecisionTools(ctx)?.map((tool) => tool.name)).toEqual([
      'glob', 'grep', 'read',
    ]);
  });

  it('ignores memory candidates that were inspected but excluded from Context', () => {
    const ctx = context('请查看当前工作区顶层有哪些条目，只告诉我数量和名称，不要修改任何文件。');
    ctx.memoryKnownState = knownState('excluded');
    expect(resolveCompactAutonomousReadDecisionTools(ctx)?.map((tool) => tool.name)).toEqual([
      'glob', 'grep', 'read',
    ]);
  });

  it.each(['adopted', 'conflicted'] as const)(
    'rejects a task with %s memory evidence',
    (decision) => {
      const ctx = context('请查看当前工作区顶层有哪些条目，只告诉我数量和名称，不要修改任何文件。');
      ctx.memoryKnownState = knownState(decision);
      expect(resolveCompactAutonomousReadDecisionTools(ctx)).toBeUndefined();
    },
  );

  it('leaves an explicitly named tool to the stricter explicit-tool path', () => {
    const ctx = context('请使用 glob 工具读取当前工作区顶层条目，只告诉我数量和名称，不要修改任何文件。');
    ctx.classification = {
      activity: 'execute',
      type: 'problem',
      confidence: 0.96,
      source: 'rules',
      reason: 'explicit tool instruction',
    };
    expect(resolveCompactAutonomousReadDecisionTools(ctx)).toBeUndefined();
  });

  it.each([
    '请查看并修改当前工作区的配置文件。',
    '继续查看刚才那个目录。',
    'Run npm test and show the output files.',
  ])('rejects context-dependent or mutating request: %s', (request) => {
    expect(resolveCompactAutonomousReadDecisionTools(context(request))).toBeUndefined();
  });

  it('revalidates an LLM-selected one-step glob TaskBook for compact execution', () => {
    const ctx = context(
      '请查看当前工作区顶层有哪些条目，只告诉我数量和名称，不要修改任何文件。',
      taskBook({ tools: ['glob'] }),
    );
    expect(resolveCompactAutonomousReadExecutionTools(ctx)?.map((tool) => tool.name)).toEqual(['glob']);
  });

  it('rejects direct proposals and non-read-only TaskBooks', () => {
    const direct = context('请查看当前工作区文件。', taskBook({
      tools: ['glob'],
      toolProposal: { name: 'glob', input: { pattern: '*' } },
    }));
    const write = context('请查看当前工作区文件。', taskBook({
      tools: ['write'],
      sideEffect: 'write',
    }));
    expect(resolveCompactAutonomousReadExecutionTools(direct)).toBeUndefined();
    expect(resolveCompactAutonomousReadExecutionTools(write)).toBeUndefined();
  });
});

function context(request: string, book?: TaskBook) {
  const tools = [
    makeTool('glob', { ok: true, output: [] }),
    makeTool('grep', { ok: true, output: [] }),
    makeTool('read', { ok: true, output: '' }),
    makeTool('write', { ok: true, output: undefined }),
  ];
  return makeCtx({
    inbound: textMessage('user', request),
    classification: {
      activity: 'execute',
      type: 'problem',
      confidence: 0.95,
      source: 'llm',
      reason: 'workspace inspection requires evidence',
    },
    tools,
    toolSources: Object.fromEntries(tools.map((tool) => [tool.name, 'builtin'])),
    taskBook: book,
  });
}

function taskBook(options: {
  tools: string[];
  toolProposal?: { name: string; input: unknown };
  sideEffect?: 'none' | 'read' | 'write' | 'external';
}): TaskBook {
  return {
    assessment: {
      userNeed: '查看工作区条目',
      complexity: 'trivial',
      goal: '列出顶层条目',
      successCriteria: ['返回数量和名称'],
      requiresTaskBook: false,
      maxExtraScopeRatio: 1,
    },
    goal: '列出顶层条目',
    complexity: 'trivial',
    successCriteria: ['返回数量和名称'],
    steps: [{
      id: 'step-1',
      title: '查看条目',
      description: '读取并列出工作区顶层条目',
      tools: options.tools,
      toolProposal: options.toolProposal,
      execution: { mode: 'serial', sideEffect: options.sideEffect ?? 'read' },
      acceptanceCriteria: ['数量和名称来自工具证据'],
      expectedOutput: '条目数量和名称',
      status: 'pending',
    }],
    overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: '保持只读范围' },
  };
}

function knownState(decision: 'adopted' | 'excluded' | 'conflicted'): RuntimeMemoryKnownState {
  const at = '2026-08-04T00:00:00.000Z';
  return {
    version: 1,
    runId: 'run-1',
    revision: 1,
    updatedAt: at,
    references: [{
      atomId: 'atom-1',
      atomRevision: 1,
      sourceRefs: ['source-1'],
      evidenceRefs: ['evidence-1'],
      decision,
      reason: decision,
      envelope: {
        atomId: 'atom-1',
        atomRevision: 1,
        branch: 'long-term',
        scope: 'user',
        tier: 1,
        disclosureLevel: 'D1',
        statementKind: 'preference',
        epistemicStatus: 'suggestion',
        authorityScope: { kind: 'user', scope: 'user', topics: [] },
        assertedBy: { kind: 'user' },
        sourceRefs: ['source-1'],
        evidenceRefs: ['evidence-1'],
        confidence: 0.5,
        importance: 0.5,
        updatedAt: at,
        retrievalPath: 'hierarchy',
        matchReason: 'test',
        conflict: decision === 'conflicted',
        expired: false,
        truncated: true,
      },
      stages: ['prime'],
      firstSeenAt: at,
      updatedAt: at,
      reactivatedCount: 0,
    }],
  };
}
