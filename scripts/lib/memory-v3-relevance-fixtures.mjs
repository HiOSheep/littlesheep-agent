export function createMemoryV3RelevanceFixture(workspaceA, workspaceB) {
  const atoms = [
    atom({
      id: 'relevance-user-concise',
      branch: 'long-term',
      summary: '用户偏好简洁直接的工程进度回复',
      content: '用户希望工程进度回复简洁、直接、事实清楚，不需要无效鼓励和冗长铺垫。',
      retrievalKeys: ['进度回复', '简洁回复', 'concise engineering update'],
      statementKind: 'preference',
      authorityKind: 'user-self',
      domain: 'user',
    }),
    atom({
      id: 'relevance-memory-navigation',
      branch: 'long-term',
      summary: 'Memory v3 使用索引优先的渐进检索路径',
      content: '记忆检索先经过 root index 和 branch index，再展开局部 Atom；只有已选择分支内的 deep search 才允许使用本地向量。',
      retrievalKeys: ['索引优先', '记忆导航', 'branch scoped deep search', 'vector fallback'],
    }),
    atom({
      id: 'relevance-memory-confidence',
      branch: 'long-term',
      summary: '重复访问不能提高事实可信度',
      content: 'Atom 被读取、重复出现或停留在 Context 中都不能提高 confidence；可信度只随权威来源或验证证据变化。',
      retrievalKeys: ['访问次数', '事实可信度', 'confidence evidence'],
    }),
    atom({
      id: 'relevance-memory-offline',
      branch: 'long-term',
      summary: '记忆 Embedding 默认完全本地运行',
      content: '未经用户明确启用，不得把记忆正文发送到 Provider embeddings endpoint；Memory v3 默认只使用本地模型。',
      retrievalKeys: ['本地 embedding', 'provider embeddings', '记忆隐私', 'offline vectorization'],
    }),
    atom({
      id: 'relevance-memory-offline-disputed',
      branch: 'long-term',
      summary: '未经证实的相反说法：默认发送远程 Embedding',
      content: '一个外部来源声称记忆默认发送给 Provider embeddings，但该说法与当前运行规则冲突。',
      retrievalKeys: ['provider embeddings', 'remote memory embedding'],
      epistemicStatus: 'disputed',
      authorityKind: 'external-source',
      confidence: 0.76,
      importance: 0.72,
    }),
    atom({
      id: 'relevance-data-root',
      branch: 'long-term',
      summary: '应用数据根与默认 workplace 的边界',
      content: '完整 LS 应用数据根可整体迁移；workplace 只是用户未选择项目时使用的默认工作区子目录。',
      retrievalKeys: ['应用数据根', '默认工作区', 'workplace', 'data root', 'fallback workspace when no project is selected'],
    }),
    atom({
      id: 'relevance-core-protection',
      branch: 'long-term',
      summary: 'LS 当前不能自行修改核心源码',
      content: '内置 write、edit 和 exec 受核心源码路径硬闸保护，当前阶段 Agent 不能自动改写自己的核心实现。',
      retrievalKeys: ['核心源码保护', 'self modification', '自修改'],
    }),
    atom({
      id: 'relevance-channel-plugin',
      branch: 'long-term',
      summary: '外部消息渠道是可选插件',
      content: 'Telegram、飞书、QQ Bot 和 Webhook 只负责外部消息转发，不是本地 UI 与 Agent 核心启动依赖。',
      retrievalKeys: ['外部渠道', '消息插件', 'local ui startup', 'channel connector'],
    }),
    atom({
      id: 'relevance-context-time',
      branch: 'long-term',
      summary: '每次模型调用注入实时运行状态',
      content: '实际模型调用前重新注入当前年月日时分秒、时区、任务进度和工具耗时；普通回复默认不展示低价值耗时。',
      retrievalKeys: ['时间感知', '工具耗时', 'runtime clock'],
    }),
    atom({
      id: 'relevance-ui-transition',
      branch: 'long-term',
      summary: '设置页转场持续 750ms',
      content: '设置页打开与关闭复用同一遮盖过程的正反方向，统一持续 750ms。',
      retrievalKeys: ['设置页动画', '750ms', 'transition duration'],
    }),
    atom({
      id: 'relevance-sqlite-wal',
      branch: 'experience',
      summary: 'Windows SQLite WAL 锁恢复经验',
      content: 'Windows 上 SQLite WAL 可能短暂持有文件锁；应设置 busy_timeout，在有序关闭时 checkpoint，并采用有限重试。',
      retrievalKeys: ['sqlite wal', 'database lock', 'busy timeout', 'windows lock'],
      domain: 'experience',
    }),
    atom({
      id: 'relevance-daily-duration',
      branch: 'daily',
      summary: '上一轮执行耗时属于运行日志事实',
      content: '上一轮任务总耗时和工具耗时保存在执行日志及有界 sidecar 中，默认不主动展示给用户。',
      retrievalKeys: ['上一轮耗时', '执行日志', 'run duration'],
      domain: 'session',
    }),
    atom({
      id: 'relevance-project-a-package',
      branch: 'project',
      scope: 'project',
      scopeKey: workspaceA,
      summary: '项目 Alpha 使用 pnpm',
      content: '项目 Alpha 的 workspace 统一使用 pnpm，不使用 npm 或 yarn。',
      retrievalKeys: ['alpha package manager', 'pnpm workspace', '包管理器'],
      authorityKind: 'project-owner',
      domain: 'project',
    }),
    atom({
      id: 'relevance-project-a-aurora',
      branch: 'project',
      scope: 'project',
      scopeKey: workspaceA,
      summary: '项目 Alpha 的 Aurora 保留策略',
      content: 'Aurora 策略为项目 Alpha 保留七个每日恢复点和四个每周恢复点。',
      retrievalKeys: ['aurora retention', 'alpha recovery points', '保留策略'],
      authorityKind: 'project-owner',
      domain: 'project',
    }),
    atom({
      id: 'relevance-project-b-package',
      branch: 'project',
      scope: 'project',
      scopeKey: workspaceB,
      summary: '项目 Beta 使用 bun',
      content: '项目 Beta 使用 bun 管理依赖，与项目 Alpha 的 pnpm 决策相互独立。',
      retrievalKeys: ['beta package manager', 'bun workspace', '包管理器'],
      authorityKind: 'project-owner',
      domain: 'project',
    }),
    atom({
      id: 'relevance-project-b-aurora',
      branch: 'project',
      scope: 'project',
      scopeKey: workspaceB,
      summary: '项目 Beta 的 Aurora 保留策略',
      content: 'Aurora 策略在项目 Beta 只保留两个临时恢复点，不得传播到项目 Alpha。',
      retrievalKeys: ['aurora retention', 'beta recovery points', '保留策略'],
      authorityKind: 'project-owner',
      domain: 'project',
    }),
  ];

  const d1Cases = [
    positive('d1-zh-preference', 'zh', '用户喜欢怎样的工程进度回复？', 'relevance-user-concise', 'long-term', workspaceA),
    positive('d1-memory-route', 'mixed', 'Memory v3 的索引优先路径是什么？', 'relevance-memory-navigation', 'long-term', workspaceA),
    positive('d1-confidence', 'zh', '访问次数会不会提高事实可信度？', 'relevance-memory-confidence', 'long-term', workspaceA),
    positive('d1-offline', 'mixed', '记忆默认会发到 provider embeddings 吗？', 'relevance-memory-offline', 'long-term', workspaceA, ['relevance-memory-offline-disputed']),
    positive('d1-data-root', 'mixed', 'workplace 和 data root 是什么关系？', 'relevance-data-root', 'long-term', workspaceA),
    positive('d1-project-a-package', 'zh', 'Alpha 项目使用什么包管理器？', 'relevance-project-a-package', 'project', workspaceA),
    positive('d1-project-a-aurora', 'mixed', 'aurora retention policy', 'relevance-project-a-aurora', 'project', workspaceA),
    positive('d1-channel', 'zh', '外部消息渠道是不是本地核心依赖？', 'relevance-channel-plugin', 'long-term', workspaceA),
    negative('d1-negative-weather', 'zh', '明天香港天气怎么样？', workspaceA),
    negative('d1-negative-recipe', 'zh', '请给我一份番茄炒蛋食谱。', workspaceA),
    negative('d1-negative-generic', 'zh', '请帮我测试一下。', workspaceA),
  ];

  const deepSearchCases = [
    deep('deep-concise-en', 'en', 'How do I keep engineering status messages terse and factual?', 'relevance-user-concise', 'long-term', workspaceA),
    deep('deep-navigation-en', 'en', 'Can similarity search happen before choosing a memory branch?', 'relevance-memory-navigation', 'long-term', workspaceA),
    deep('deep-confidence-en', 'en', 'Does repeatedly reading a belief make it true?', 'relevance-memory-confidence', 'long-term', workspaceA),
    deep('deep-offline-en', 'en', 'Will private recollections leave the machine for vectorization?', 'relevance-memory-offline', 'long-term', workspaceA),
    deep('deep-data-root-en', 'en', 'Which folder is only the fallback sandbox when no project is selected?', 'relevance-data-root', 'long-term', workspaceA),
    deep('deep-channel-zh', 'zh', '消息转发服务故障会不会阻止本地界面启动？', 'relevance-channel-plugin', 'long-term', workspaceA),
    deep('deep-core-zh', 'zh', '程序现在能否自动改写自己的实现？', 'relevance-core-protection', 'long-term', workspaceA),
    deep('deep-sqlite-mixed', 'mixed', 'Windows 数据库文件被占用时怎样恢复？', 'relevance-sqlite-wal', 'experience', workspaceA),
    deep('deep-project-a', 'zh', 'Alpha 要保留多少个每日恢复点？', 'relevance-project-a-aurora', 'project', workspaceA),
    deep('deep-project-b', 'zh', 'Beta 的依赖管理工具是什么？', 'relevance-project-b-package', 'project', workspaceB),
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
    sourceRunId: `stage9:${options.id}`,
    sourceStage: 'tool',
    sourceRefs: [`conversation-source:stage9:${options.id}:assistant-message:fixture`],
    importance: options.importance ?? 0.82,
    confidence: options.confidence ?? 0.92,
    reason: 'Memory v3 stage 9 isolated relevance fixture.',
    epistemic: {
      domain: options.domain ?? 'knowledge',
      statementKind: options.statementKind ?? 'factual-claim',
      epistemicStatus: options.epistemicStatus ?? 'verified',
      authorityScope: {
        kind: authorityKind,
        scope,
        ...(scopeKey ? { scopeKey } : {}),
        topics: options.retrievalKeys.slice(0, 6),
      },
      assertedBy: authorityKind === 'user-self'
        ? { kind: 'user', id: 'stage9-user' }
        : authorityKind === 'external-source'
          ? { kind: 'external', id: 'stage9-external' }
          : { kind: 'tool', id: 'stage9-fixture' },
      evidenceRefs: [`stage9:fixture:${options.id}`],
    },
  };
}

function positive(id, category, query, expected, branch, workspace, allowedExtra = []) {
  return { id, category, query, expected, branch, workspace, allowed: [expected, ...allowedExtra] };
}

function negative(id, category, query, workspace) {
  return { id, category, query, expected: undefined, workspace, allowed: [] };
}

function deep(id, category, query, expected, branch, workspace) {
  return { id, category, query, expected, branch, workspace };
}
