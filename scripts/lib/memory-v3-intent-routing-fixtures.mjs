export function createMemoryV3IntentRoutingFixture(workspaceA, workspaceB) {
  const atoms = [
    atom({
      id: 'intent-atom-routing',
      branch: 'long-term',
      summary: 'Atom 注入按当前任务相关性动态选择',
      content: 'Memory v3 根据当前任务、作用域、权威、认识状态和预算选择 Atom；执行中可以释放无关 Atom。',
      retrievalKeys: ['Atom 注入相关性', '动态 working set', 'memory atom routing'],
    }),
    atom({
      id: 'intent-checkpoint-recovery',
      branch: 'long-term',
      summary: 'Long-session checkpoint recovery is bounded and resumable',
      content: 'Long tasks persist bounded checkpoints so an interrupted session can resume without replaying the whole transcript.',
      retrievalKeys: ['checkpoint recovery', 'long session continuity', 'resume interrupted task'],
    }),
    atom({
      id: 'intent-ui-theme',
      branch: 'long-term',
      summary: 'LS 主界面使用统一深灰色主题',
      content: '主页、顶部栏和设置页使用统一深灰背景，交互状态通过轻微明度变化表达。',
      retrievalKeys: ['深灰色界面', 'UI 主题', 'dark gray theme'],
    }),
    atom({
      id: 'intent-old-plan',
      branch: 'long-term',
      summary: '旧方案：把全部历史直接放入上下文',
      content: '旧方案在每轮请求中重放全部历史和全部记忆文件。',
      retrievalKeys: ['旧方案', '全量历史', 'replay all history'],
      importance: 0.9,
    }),
    atom({
      id: 'intent-old-plan-rejected',
      branch: 'long-term',
      summary: '旧方案已被明确否决',
      content: '用户决定不再采用旧方案，禁止把全部历史和整棵记忆树直接注入上下文。',
      retrievalKeys: ['旧方案', '禁止全量历史', 'old plan rejected'],
      statementKind: 'decision',
      authorityKind: 'user-self',
      domain: 'user',
      importance: 0.96,
    }),
    atom({
      id: 'intent-index-plan',
      branch: 'long-term',
      summary: '新方案：沿索引按需注入 Atom',
      content: '新方案先沿根索引和分支索引缩小候选，再按相关性和预算注入 Atom。',
      retrievalKeys: ['新方案', '索引注入', '按需 Atom'],
      importance: 0.94,
    }),
    atom({
      id: 'intent-old-cache',
      branch: 'long-term',
      summary: '旧缓存策略使用无界全量缓存',
      content: '旧缓存策略让所有中间状态永久常驻内存，缺少层级和容量上限。',
      retrievalKeys: ['旧缓存策略', '无界缓存', 'unbounded cache'],
    }),
    atom({
      id: 'intent-old-cache-rejected',
      branch: 'long-term',
      summary: '旧缓存策略已停用',
      content: '旧缓存策略已经废弃，不再使用无界全量缓存。',
      retrievalKeys: ['旧缓存策略', '缓存停用', 'deprecated cache'],
      statementKind: 'decision',
      authorityKind: 'user-self',
      domain: 'user',
    }),
    atom({
      id: 'intent-layered-cache',
      branch: 'long-term',
      summary: '分层原子缓存采用三级上限',
      content: '新缓存策略将运行缓存原子化并限制为最多三级，超过层级时进行有界压缩。',
      retrievalKeys: ['分层缓存', '三级缓存', 'atomic bounded cache'],
    }),
    atom({
      id: 'intent-project-a-aurora',
      branch: 'project',
      scope: 'project',
      scopeKey: workspaceA,
      summary: '项目 Alpha 的 Aurora 保留策略',
      content: '项目 Alpha 保留七个每日恢复点和四个每周恢复点。',
      retrievalKeys: ['Alpha Aurora', '保留策略', 'seven daily recovery points'],
      authorityKind: 'project-owner',
      domain: 'project',
    }),
    atom({
      id: 'intent-project-b-aurora',
      branch: 'project',
      scope: 'project',
      scopeKey: workspaceB,
      summary: '项目 Beta 的 Aurora 保留策略',
      content: '项目 Beta 只保留两个临时恢复点。',
      retrievalKeys: ['Beta Aurora', '保留策略', 'two temporary recovery points'],
      authorityKind: 'project-owner',
      domain: 'project',
    }),
  ];

  const d1Cases = [
    {
      id: 'zh-reference',
      query: '继续处理它',
      history: [
        { role: 'user', content: '请优化 Atom 注入相关性。' },
        { role: 'assistant', content: '下一步会处理多轮指代和任务转向。' },
      ],
      workspace: workspaceA,
      required: ['intent-atom-routing'],
      allowed: ['intent-atom-routing'],
      forbidden: ['intent-ui-theme'],
    },
    {
      id: 'en-reference',
      query: 'Continue with that.',
      history: [
        { role: 'user', content: 'Please improve checkpoint recovery for long sessions.' },
        { role: 'assistant', content: 'The next step will make interrupted work resumable.' },
      ],
      workspace: workspaceA,
      required: ['intent-checkpoint-recovery'],
      allowed: ['intent-checkpoint-recovery'],
      forbidden: [],
    },
    {
      id: 'assistant-selection',
      query: '按你刚才的第二个方案做',
      history: [
        { role: 'user', content: '怎样避免记忆上下文膨胀？' },
        { role: 'assistant', content: '方案一是全量历史；方案二是沿索引按需注入 Atom。' },
      ],
      workspace: workspaceA,
      required: ['intent-index-plan'],
      allowed: ['intent-index-plan', 'intent-old-plan-rejected'],
      forbidden: ['intent-old-plan'],
    },
    {
      id: 'negative-replacement',
      query: '不要旧方案，改用新方案沿索引按需注入 Atom',
      history: [],
      workspace: workspaceA,
      required: ['intent-index-plan', 'intent-old-plan-rejected'],
      allowed: ['intent-index-plan', 'intent-old-plan-rejected'],
      forbidden: ['intent-old-plan'],
    },
    {
      id: 'task-shift',
      query: '换个话题，检查深灰色界面主题',
      history: [
        { role: 'user', content: '请继续优化 Atom 注入相关性。' },
        { role: 'assistant', content: '正在处理记忆检索。' },
      ],
      workspace: workspaceA,
      required: ['intent-ui-theme'],
      allowed: ['intent-ui-theme'],
      forbidden: ['intent-atom-routing'],
    },
    {
      id: 'self-contained-demonstrative',
      query: '这个项目的 Aurora 保留策略是什么？',
      history: [
        { role: 'user', content: '旧话题是深灰色界面。' },
        { role: 'assistant', content: '设置页保持统一主题。' },
      ],
      workspace: workspaceA,
      required: ['intent-project-a-aurora'],
      allowed: ['intent-project-a-aurora'],
      forbidden: ['intent-project-b-aurora', 'intent-ui-theme'],
    },
    {
      id: 'project-scope-b',
      query: '这个项目的 Aurora 保留策略是什么？',
      history: [],
      workspace: workspaceB,
      required: ['intent-project-b-aurora'],
      allowed: ['intent-project-b-aurora'],
      forbidden: ['intent-project-a-aurora'],
    },
    {
      id: 'unresolved-reference',
      query: '这个呢？',
      history: [],
      workspace: workspaceA,
      required: [],
      allowed: [],
      forbidden: atoms.map((entry) => entry.id),
    },
  ];

  const deepSearchCases = [
    {
      id: 'negative-cache-routing',
      query: '不要旧缓存策略，使用分层原子缓存和三级上限',
      branch: 'long-term',
      workspace: workspaceA,
      required: ['intent-layered-cache', 'intent-old-cache-rejected'],
      forbidden: ['intent-old-cache'],
    },
    {
      id: 'project-scope-deep',
      query: 'How many Aurora recovery points belong to this project?',
      branch: 'project',
      workspace: workspaceB,
      required: ['intent-project-b-aurora'],
      forbidden: ['intent-project-a-aurora'],
    },
  ];

  return { atoms, d1Cases, deepSearchCases };
}

function atom(options) {
  const scope = options.scope ?? 'global';
  const scopeKey = options.scopeKey;
  const authorityKind = options.authorityKind ?? 'tool-evidence';
  return {
    id: options.id,
    branch: options.branch,
    parentNodeId: `${options.branch}:root`,
    scope,
    scopeKey,
    tier: 2,
    summary: options.summary,
    content: options.content,
    retrievalKeys: options.retrievalKeys,
    sourceRunId: `stage11:${options.id}`,
    sourceStage: 'tool',
    sourceRefs: [`conversation-source:stage11:${options.id}:assistant-message:fixture`],
    importance: options.importance ?? 0.84,
    confidence: 0.94,
    reason: 'Memory v3 stage 11 isolated intent-routing fixture.',
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
        ? { kind: 'user', id: 'stage11-user' }
        : { kind: 'tool', id: 'stage11-fixture' },
      evidenceRefs: [`stage11:fixture:${options.id}`],
    },
  };
}
