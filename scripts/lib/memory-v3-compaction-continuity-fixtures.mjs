export function createMemoryV3CompactionContinuityFixture(sessionA, sessionB) {
  const atoms = [
    atom({
      id: 'continuity-aster-checkpoint',
      summary: 'Aster checkpoint recovery contract',
      content: 'Aster long tasks resume from a bounded checkpoint after an application restart.',
      retrievalKeys: ['Aster checkpoint recovery', 'resume after restart', 'bounded checkpoint'],
    }),
    atom({
      id: 'continuity-atom-routing',
      summary: 'Atom injection follows task relevance',
      content: 'Memory v3 selects Atom context by the current task, scope, evidence, usefulness and budget.',
      retrievalKeys: ['Atom injection relevance', 'memory routing', 'context budget'],
    }),
    atom({
      id: 'continuity-ui-theme',
      summary: 'LS 使用统一深灰色界面主题',
      content: '主页、顶部栏与设置页采用统一深灰色背景和轻量交互高亮。',
      retrievalKeys: ['深灰色界面', 'UI 主题', 'dark gray theme'],
    }),
    atom({
      id: 'continuity-old-plan',
      summary: 'Old plan replays the complete transcript',
      content: 'The old plan injects the complete transcript and every memory file into each request.',
      retrievalKeys: ['old plan', 'complete transcript', 'full memory replay'],
    }),
    atom({
      id: 'continuity-old-plan-rejected',
      summary: 'The old plan is rejected',
      content: 'The user decided not to use the old plan and forbids complete transcript replay.',
      retrievalKeys: ['old plan', 'old plan rejected', 'no transcript replay'],
      statementKind: 'decision',
      authorityKind: 'user-self',
      domain: 'user',
      importance: 0.96,
    }),
    atom({
      id: 'continuity-index-plan',
      summary: 'New index-guided Atom plan',
      content: 'The new plan follows indexes and injects only task-relevant Atom context.',
      retrievalKeys: ['new index plan', 'index guided Atom', 'task relevant context'],
      importance: 0.94,
    }),
    atom({
      id: 'continuity-session-a',
      branch: 'daily',
      parentNodeId: 'daily:root',
      scope: 'session',
      scopeKey: sessionA,
      summary: 'Session Alpha continuity marker',
      content: 'Session Alpha owns marker ALPHA-CONTINUITY-ONLY.',
      retrievalKeys: ['Session Alpha marker', 'ALPHA-CONTINUITY-ONLY'],
      domain: 'session',
    }),
    atom({
      id: 'continuity-session-b',
      branch: 'daily',
      parentNodeId: 'daily:root',
      scope: 'session',
      scopeKey: sessionB,
      summary: 'Session Beta continuity marker',
      content: 'Session Beta owns marker BETA-CONTINUITY-ONLY.',
      retrievalKeys: ['Session Beta marker', 'BETA-CONTINUITY-ONLY'],
      domain: 'session',
    }),
  ];

  const cases = [
    {
      id: 'zh-summary-fallback',
      sessionId: sessionA,
      query: '继续',
      history: [{ role: 'assistant', content: '下一步继续执行。' }],
      summary: summary('summary-zh-aster', '当前目标：完成 Aster checkpoint recovery contract。下一步：验证跨重启恢复。'),
      required: ['continuity-aster-checkpoint'],
      allowed: ['continuity-aster-checkpoint'],
      forbidden: [],
      summaryUsed: true,
    },
    {
      id: 'en-summary-fallback',
      sessionId: sessionA,
      query: 'Continue with that.',
      history: [{ role: 'assistant', content: 'Ready for the next step.' }],
      summary: summary('summary-en-routing', 'Current goal: finish Atom injection relevance routing. Next step: verify the context budget.'),
      required: ['continuity-atom-routing'],
      allowed: ['continuity-atom-routing'],
      forbidden: [],
      summaryUsed: true,
    },
    {
      id: 'recent-goal-wins',
      sessionId: sessionA,
      query: '继续处理它',
      history: [{ role: 'user', content: '请优化深灰色界面主题。' }],
      summary: summary('summary-stale-aster', '当前目标：完成 Aster checkpoint recovery contract。'),
      required: ['continuity-ui-theme'],
      allowed: ['continuity-ui-theme'],
      forbidden: ['continuity-aster-checkpoint'],
      summaryUsed: false,
    },
    {
      id: 'task-shift-ignores-summary',
      sessionId: sessionA,
      query: '换个话题，检查 Atom injection relevance',
      history: [{ role: 'assistant', content: '下一步继续执行。' }],
      summary: summary('summary-old-aster', '当前目标：完成 Aster checkpoint recovery contract。'),
      required: ['continuity-atom-routing'],
      allowed: ['continuity-atom-routing'],
      forbidden: ['continuity-aster-checkpoint'],
      summaryUsed: false,
    },
    {
      id: 'summary-negative-decision',
      sessionId: sessionA,
      query: '继续',
      history: [{ role: 'assistant', content: 'Proceed with the next step.' }],
      summary: summary('summary-plan-decision', 'Current decision: do not use the old plan. Next step: use the new index plan.'),
      required: ['continuity-index-plan', 'continuity-old-plan-rejected'],
      allowed: ['continuity-index-plan', 'continuity-old-plan-rejected'],
      forbidden: ['continuity-old-plan'],
      summaryUsed: true,
    },
    {
      id: 'session-scope-isolation',
      sessionId: sessionA,
      query: '继续',
      history: [{ role: 'assistant', content: 'Continue.' }],
      summary: summary('summary-session-alpha', 'Current goal: restore the Session Alpha marker ALPHA-CONTINUITY-ONLY.'),
      required: ['continuity-session-a'],
      allowed: ['continuity-session-a'],
      forbidden: ['continuity-session-b'],
      summaryUsed: true,
    },
    {
      id: 'unresolved-without-summary',
      sessionId: sessionA,
      query: '继续',
      history: [{ role: 'assistant', content: 'Continue.' }],
      required: [],
      allowed: [],
      forbidden: atoms.map((entry) => entry.id),
      summaryUsed: false,
    },
  ];

  return { atoms, cases };
}

function summary(id, content) {
  return { id, content };
}

function atom(options) {
  const scope = options.scope ?? 'global';
  const scopeKey = options.scopeKey;
  const authorityKind = options.authorityKind ?? 'tool-evidence';
  return {
    id: options.id,
    branch: options.branch ?? 'long-term',
    parentNodeId: options.parentNodeId ?? 'long-term:root',
    scope,
    scopeKey,
    tier: 2,
    summary: options.summary,
    content: options.content,
    retrievalKeys: options.retrievalKeys,
    sourceRunId: `stage12:${options.id}`,
    sourceStage: 'tool',
    sourceRefs: [`conversation-source:stage12:${options.id}:assistant-message:fixture`],
    importance: options.importance ?? 0.86,
    confidence: 0.95,
    reason: 'Memory v3 stage 12 isolated compaction-continuity fixture.',
    epistemic: {
      domain: options.domain ?? 'knowledge',
      statementKind: options.statementKind ?? 'factual-claim',
      epistemicStatus: 'verified',
      authorityScope: {
        kind: authorityKind,
        scope,
        ...(scopeKey ? { scopeKey } : {}),
        topics: options.retrievalKeys.slice(0, 6),
      },
      assertedBy: authorityKind === 'user-self'
        ? { kind: 'user', id: 'stage12-user' }
        : { kind: 'tool', id: 'stage12-fixture' },
      evidenceRefs: [`stage12:fixture:${options.id}`],
    },
  };
}
