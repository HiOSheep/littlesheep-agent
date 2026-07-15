import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  LocalTransformersEmbeddingEngine,
  getLocalEmbeddingModel,
  provisionLocalEmbeddingModel,
  verifyLocalEmbeddingModel,
} from '../packages/embedding/dist/index.js';

const documents = [
  { id: 'user-concise', text: '用户偏好简洁、直接、事实清楚的工程进度更新，不需要无效的鼓励和铺垫。' },
  { id: 'project-pnpm', text: 'LittleSheep 项目统一使用 pnpm 管理 workspace，完整质量门是 pnpm run verify:full。' },
  { id: 'memory-navigation', text: '记忆检索固定沿 root index、branch index、hierarchy expansion，再在已选择分支内使用 FTS 或向量。' },
  { id: 'memory-feedback', text: '重复访问记忆不能提高可信度，只有用户确认或工具证据加成功 VERIFY 才能形成正向反馈。' },
  { id: 'sqlite-wal', text: 'Windows 上 SQLite WAL 可能短暂持有锁，应设置 busy_timeout 并在关闭时执行 checkpoint。' },
  { id: 'abort-controller', text: 'Use AbortController to cancel an active streaming request and propagate the signal into tool execution.' },
  { id: 'typescript-strict', text: 'TypeScript packages compile with strict, noUncheckedIndexedAccess, and project references.' },
  { id: 'electron-api', text: 'The renderer communicates with the Electron main process through a loopback Local App API, not through external channels.' },
  { id: 'provider-models', text: '模型供应商至少支持 OpenAI、DeepSeek 和 GLM，只有配置密钥的模型才出现在选择列表中。' },
  { id: 'ui-transition', text: '设置页转场统一为 750ms，打开和关闭使用同一遮盖过程的正反方向。' },
  { id: 'workspace-default', text: '完整应用数据根可以迁移，workplace 只是用户没有选择项目时使用的默认工作区子目录。' },
  { id: 'core-protection', text: 'LS 当前不得修改自己的核心源码；内置 write、edit 和 exec 都受核心路径硬闸保护。' },
  { id: 'code-retry', text: 'async function retry(task, limit) { for (let i = 0; i < limit; i++) { try { return await task(); } catch {} } throw new Error("exhausted"); }' },
  { id: 'python-parser', text: 'def parse_records(lines): return [json.loads(line) for line in lines if line.strip()]' },
  { id: 'memory-atom', text: 'A MemoryAtom has a stable id, parentId, branch, scope, epistemic status, authority scope, evidence references, revision, and content hash.' },
  { id: 'channel-plugin', text: 'Telegram、飞书、QQ Bot 和 Webhook 都是可选渠道插件，不参与本地 Agent 核心启动。' },
  { id: 'context-time', text: '每次真实模型调用前注入当前本地年月日时分秒、时区、任务进度和工具耗时，普通回复默认只报时分。' },
  { id: 'memory-offline', text: 'Memory v3 默认使用本地 Embedding，未经用户明确启用不得把记忆正文发送到 Provider embeddings endpoint。' },
];

const queries = [
  { id: 'q1', category: 'zh', text: '用户喜欢怎样的开发进度回复？', expected: 'user-concise' },
  { id: 'q2', category: 'zh', text: '这个仓库使用什么包管理器？', expected: 'project-pnpm' },
  { id: 'q3', category: 'zh', text: '记忆应该按照什么路径检索？', expected: 'memory-navigation' },
  { id: 'q4', category: 'zh', text: '访问次数是否会让记忆变得更可信？', expected: 'memory-feedback' },
  { id: 'q5', category: 'zh', text: 'Windows 下数据库锁要如何缓解？', expected: 'sqlite-wal' },
  { id: 'q6', category: 'en', text: 'How should an active stream be cancelled?', expected: 'abort-controller' },
  { id: 'q7', category: 'en', text: 'Which strict TypeScript compiler safeguards are enabled?', expected: 'typescript-strict' },
  { id: 'q8', category: 'mixed', text: 'renderer 如何调用 main process？', expected: 'electron-api' },
  { id: 'q9', category: 'zh', text: '支持哪些模型供应商？', expected: 'provider-models' },
  { id: 'q10', category: 'zh', text: '设置页面动画需要多长时间？', expected: 'ui-transition' },
  { id: 'q11', category: 'mixed', text: 'where is the default 工作区 located conceptually?', expected: 'workspace-default' },
  { id: 'q12', category: 'zh', text: 'LS 现在能不能改自己的源码？', expected: 'core-protection' },
  { id: 'q13', category: 'code', text: 'find the JavaScript bounded retry implementation', expected: 'code-retry' },
  { id: 'q14', category: 'code', text: 'Python function that parses JSON lines', expected: 'python-parser' },
  { id: 'q15', category: 'en', text: 'What metadata belongs to one atomic memory record?', expected: 'memory-atom' },
  { id: 'q16', category: 'zh', text: '外部消息渠道是不是核心依赖？', expected: 'channel-plugin' },
  { id: 'q17', category: 'zh', text: 'LS 如何获得当前时间和工具耗时？', expected: 'context-time' },
  { id: 'q18', category: 'mixed', text: 'Can memory content be sent to provider embeddings by default?', expected: 'memory-offline' },
];

const args = parseArgs(process.argv.slice(2));
const model = getLocalEmbeddingModel(args.model);
await mkdir(args.cacheDir, { recursive: true });
if (args.allowDownload) {
  await provisionLocalEmbeddingModel({
    model: args.model,
    modelRootDir: args.cacheDir,
    remoteHost: args.remoteHost,
  });
} else {
  const verification = await verifyLocalEmbeddingModel(args.model, args.cacheDir);
  if (!verification.available) {
    throw new Error(`Local model is incomplete: missing=${verification.missing.join(',')}; invalid=${verification.invalid.join(',')}`);
  }
}

let blockedNetworkAttempts = 0;
const originalFetch = globalThis.fetch;
if (args.assertNoNetwork) {
  globalThis.fetch = async () => {
    blockedNetworkAttempts += 1;
    throw new Error('Network access is forbidden during the offline embedding benchmark.');
  };
}

const before = process.memoryUsage().rss;
const engine = new LocalTransformersEmbeddingEngine({
  model: args.model,
  modelRootDir: args.cacheDir,
  batchSize: 16,
});

const loadStarted = performance.now();
const documentResult = await engine.embed({ texts: documents.map((item) => item.text), purpose: 'document' });
const documentsReadyAt = performance.now();
const queryResult = await engine.embed({ texts: queries.map((item) => item.text), purpose: 'query' });
const completedAt = performance.now();
const after = process.memoryUsage().rss;

const details = queries.map((query, queryIndex) => {
  const ranked = documents
    .map((document, documentIndex) => ({
      id: document.id,
      score: cosine(queryResult.vectors[queryIndex], documentResult.vectors[documentIndex]),
    }))
    .sort((left, right) => right.score - left.score);
  const rank = ranked.findIndex((candidate) => candidate.id === query.expected) + 1;
  return {
    id: query.id,
    category: query.category,
    expected: query.expected,
    rank,
    top3: ranked.slice(0, 3),
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  model: {
    id: model.id,
    repository: model.repository,
    revision: model.revision,
    dimensions: model.dimensions,
    dtype: model.dtype,
    quantizedOnnxBytes: model.quantizedOnnxBytes,
  },
  corpus: { documents: documents.length, queries: queries.length },
  quality: summarize(details),
  timingMs: {
    loadAndDocuments: round(documentsReadyAt - loadStarted),
    queries: round(completedAt - documentsReadyAt),
    total: round(completedAt - loadStarted),
  },
  rssBytes: {
    before,
    after,
    delta: after - before,
  },
  offlineAssertion: {
    enabled: args.assertNoNetwork,
    blockedNetworkAttempts,
  },
  details,
};

await engine.dispose();
globalThis.fetch = originalFetch;
const json = `${JSON.stringify(report, null, 2)}\n`;
if (args.output) {
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, json, 'utf8');
}
process.stdout.write(json);

function summarize(details) {
  const reciprocalRank = details.reduce((sum, item) => sum + (item.rank > 0 ? 1 / item.rank : 0), 0);
  const categories = Object.fromEntries([...new Set(details.map((item) => item.category))].map((category) => {
    const subset = details.filter((item) => item.category === category);
    return [category, metrics(subset)];
  }));
  return { ...metrics(details), meanReciprocalRank: round(reciprocalRank / details.length), categories };
}

function metrics(items) {
  return {
    recallAt1: round(items.filter((item) => item.rank === 1).length / items.length),
    recallAt3: round(items.filter((item) => item.rank > 0 && item.rank <= 3).length / items.length),
  };
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}

function parseArgs(values) {
  const options = {
    model: undefined,
    cacheDir: resolve(process.env.TEMP ?? '.', 'littlesheep-embedding-benchmark'),
    allowDownload: false,
    output: undefined,
    remoteHost: undefined,
    assertNoNetwork: false,
  };
  for (const value of values) {
    if (value.startsWith('--model=')) options.model = value.slice('--model='.length);
    else if (value.startsWith('--cache=')) options.cacheDir = resolve(value.slice('--cache='.length));
    else if (value.startsWith('--output=')) options.output = resolve(value.slice('--output='.length));
    else if (value.startsWith('--remote-host=')) options.remoteHost = value.slice('--remote-host='.length);
    else if (value === '--allow-download') options.allowDownload = true;
    else if (value === '--assert-no-network') options.assertNoNetwork = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (options.model !== 'bge-small-zh-v1.5' && options.model !== 'multilingual-e5-small') {
    throw new Error('Use --model=bge-small-zh-v1.5 or --model=multilingual-e5-small.');
  }
  return options;
}

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}
