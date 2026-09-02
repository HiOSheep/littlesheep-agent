import { app, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BRANDING, loadBranding, resolveDataDir } from '../packages/branding/dist/index.js';
import { DEFAULT_CONFIG, getProvider, loadConfig, resolveApiKey, withProviderPresets } from '../packages/config/dist/index.js';
import { synthesizeFinalReply } from '../packages/harness/dist/stages/execute/final-reply.js';
import { createLlmClient } from '../packages/llm/dist/index.js';
import { textMessage } from '../packages/types/dist/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_ERROR_IDS = /\bweb_(?:provider_rate_limited|fetch_timeout|disabled)\b/iu;
const FALSE_CERTAINTY = /(?:已经确认|已完全验证|完全确认|100%\s*(?:确认|验证))/iu;

const SCENARIOS = [
  {
    id: 'partial-truncated',
    evidence: evidence({
      completeness: 'partial',
      citationIds: ['web-llm-partial-source'],
      citationCount: 1,
      documentCount: 1,
      partial: true,
      truncated: true,
      citations: [{
        id: 'web-llm-partial-source',
        origin: 'https://example.test',
        urlHash: 'a'.repeat(64),
        title: '受控测试来源',
        fetchedAt: '2026-08-30T00:00:00.000Z',
        status: 'partial',
        truncated: true,
      }],
    }),
    output: '本轮只获得了一条 Runtime 签发的外部资料。资料不完整且正文被截断，不能据此确认用户请求的事实。可引用来源：[citation:web-llm-partial-source]。',
    mustMention: /(?:部分|不完整|截断|无法确认|不能确认|不足|有限)/u,
    requiredCitation: 'web-llm-partial-source',
  },
  {
    id: 'rate-limited',
    evidence: evidence({
      completeness: 'none',
      partial: true,
      errorKinds: ['web_provider_rate_limited'],
    }),
    output: '本轮搜索被 Provider 限流，未取得可引用的网页资料，无法确认用户请求的事实。',
    mustMention: /(?:限流|未取得|无法确认|无法验证|未能|暂时)/u,
  },
  {
    id: 'fetch-timeout',
    evidence: evidence({
      completeness: 'partial',
      partial: true,
      errorKinds: ['web_fetch_timeout'],
    }),
    output: '本轮公开页面读取超时，没有取得足够资料确认用户请求的事实。',
    mustMention: /(?:超时|未取得|无法确认|无法验证|未能|暂时)/u,
  },
  {
    id: 'disabled',
    evidence: evidence({
      completeness: 'none',
      blocked: true,
      errorKinds: ['web_disabled'],
    }),
    output: '本轮网络读取未启用，未检索网页资料，无法确认用户请求的事实。',
    mustMention: /(?:未启用|关闭|未检索|无法确认|无法验证|未能)/u,
  },
];

async function main() {
  app.setPath('userData', resolveChromiumUserDataDir());
  await app.whenReady();

  const { provider, model, llm } = await resolveLiveLlm();
  const results = [];
  for (const scenario of SCENARIOS) {
    const startedAt = Date.now();
    const ctx = buildContext(scenario.evidence, `${provider.id}/${model}`);
    const reply = await synthesizeFinalReply(
      { model, config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING, llm },
      ctx,
      taskBook(scenario.id),
      [{
        stepId: 'web-evidence',
        description: 'Explain the Runtime-issued Web evidence state without overstating certainty.',
        status: 'done',
        output: scenario.output,
        toolCallIds: [],
        toolResults: [],
      }],
    );
    assertScenario(reply, scenario);
    const request = ctx.modelRequests?.at(-1);
    results.push({
      id: scenario.id,
      ok: true,
      durationMs: Date.now() - startedAt,
      replyChars: reply.length,
      replySha256: createHash('sha256').update(reply).digest('hex'),
      citationValid: scenario.requiredCitation ? reply.includes(`[citation:${scenario.requiredCitation}]`) : !reply.includes('[citation:'),
      caveatPresent: scenario.mustMention.test(reply),
      rawErrorIdHidden: !RAW_ERROR_IDS.test(reply),
      providerUsage: safeUsage(request?.providerUsage),
      modelRequestPurpose: request?.callContract?.purpose,
    });
  }

  console.log(JSON.stringify({
    check: 'web-llm-evidence',
    status: 'passed',
    ok: true,
    isolated: true,
    realProvider: provider.id,
    model,
    externalWebRequests: 0,
    scenarios: results,
    note: 'This validates real LLM final-reply behavior from synthetic Runtime evidence only; it is not a live search-provider or public-web acceptance test.',
  }, null, 2));
}

async function resolveLiveLlm() {
  const branding = await loadBranding(join(repoRoot, 'branding.config.json'));
  const dataDir = resolveDataDir(branding);
  injectKeys(await loadEncryptedKeys(dataDir));
  const config = withProviderPresets(await loadConfig({ dataDir }));
  const provider = getProvider(config, 'deepseek');
  if (!provider) throw new Error('DeepSeek is not configured in the active LittleSheep data root.');
  const apiKey = resolveApiKey(provider.apiKey);
  if (!apiKey) throw new Error('DeepSeek has no usable API key.');
  const configuredModel = config.agents.defaults.model.startsWith('deepseek/')
    ? config.agents.defaults.model.slice('deepseek/'.length)
    : undefined;
  const model = configuredModel ?? provider.models?.[0];
  if (!model) throw new Error('DeepSeek has no configured model.');
  return {
    provider,
    model,
    llm: createLlmClient({ baseURL: provider.baseURL, apiKey, timeoutSeconds: 120 }, { retry: { maxAttempts: 1 } }),
  };
}

function buildContext(webEvidence, model) {
  const runId = `web-llm-evidence-${crypto.randomUUID()}`;
  const sessionId = `web-llm-evidence-${crypto.randomUUID()}`;
  return {
    runId,
    sessionId,
    inbound: textMessage('user', '请根据本轮网页资料说明当前状态；资料不足时不要把它表述为已经证实的事实。'),
    cwd: repoRoot,
    model,
    tools: [],
    toolContext: { runId, sessionId, cwd: repoRoot },
    history: [],
    produced: [],
    maxRecoveryAttempts: 0,
    startedAt: new Date().toISOString(),
    webEvidence,
    maxModelCalls: 3,
    reserveUserFacingReply: async () => true,
  };
}

function taskBook(id) {
  return {
    assessment: {
      userNeed: 'report bounded web evidence without overstating certainty',
      complexity: 'standard',
      goal: `report ${id} evidence state`,
      successCriteria: ['preserve the Runtime evidence state and citation boundary'],
      requiresTaskBook: true,
      maxExtraScopeRatio: 1,
    },
    goal: `report ${id} evidence state`,
    complexity: 'standard',
    successCriteria: ['preserve the Runtime evidence state and citation boundary'],
    steps: [{ id: 'web-evidence', description: 'Report the bounded evidence state.', tools: [] }],
    overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'Do not infer facts beyond Runtime evidence.' },
  };
}

function evidence(overrides) {
  return {
    version: 1,
    generatedAt: '2026-08-30T00:00:00.000Z',
    completeness: 'complete',
    citationIds: [],
    citationCount: 0,
    documentCount: 0,
    cached: false,
    partial: false,
    truncated: false,
    blocked: false,
    stale: false,
    ...overrides,
  };
}

function assertScenario(reply, scenario) {
  if (RAW_ERROR_IDS.test(reply)) throw new Error(`${scenario.id}: reply exposed a raw Web error id.`);
  if (FALSE_CERTAINTY.test(reply)) throw new Error(`${scenario.id}: reply overstated incomplete evidence.`);
  if (!scenario.mustMention.test(reply)) throw new Error(`${scenario.id}: reply did not retain the required uncertainty state.`);
  if (scenario.requiredCitation) {
    if (!reply.includes(`[citation:${scenario.requiredCitation}]`)) {
      throw new Error(`${scenario.id}: reply omitted the Runtime-issued citation.`);
    }
  } else if (reply.includes('[citation:')) {
    throw new Error(`${scenario.id}: reply invented a citation without Runtime-issued sources.`);
  }
}

function safeUsage(value) {
  if (!value) return undefined;
  return {
    promptTokens: value.promptTokens,
    completionTokens: value.completionTokens,
    totalTokens: value.totalTokens,
  };
}

async function loadEncryptedKeys(dataDir) {
  let store;
  try {
    store = parseObject(await readFile(join(dataDir, 'config', 'keys.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  const keys = {};
  for (const [name, encoded] of Object.entries(store ?? {})) {
    if (typeof encoded !== 'string') continue;
    const encrypted = Buffer.from(encoded, 'base64');
    let plaintext;
    if (safeStorage.isEncryptionAvailable()) {
      try { plaintext = safeStorage.decryptString(encrypted); } catch { plaintext = encrypted.toString('utf8'); }
    } else {
      plaintext = encrypted.toString('utf8');
    }
    const normalized = normalizeKey(plaintext ?? '');
    if (normalized) keys[name] = normalized;
  }
  return keys;
}

function injectKeys(keys) {
  for (const [name, value] of Object.entries(keys)) {
    if (normalizeKey(value)) process.env[name] = normalizeKey(value);
  }
}

function normalizeKey(value) {
  return String(value).trim().replace(/^Bearer\s+/iu, '');
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resolveChromiumUserDataDir() {
  if (process.env.LITTLESHEEP_CHROMIUM_USER_DATA_DIR?.trim()) return resolve(process.env.LITTLESHEEP_CHROMIUM_USER_DATA_DIR);
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), '@littlesheep', 'app');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', '@littlesheep', 'app');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), '@littlesheep', 'app');
}

main().then(() => app.exit(0)).catch((error) => {
  console.error(JSON.stringify({
    check: 'web-llm-evidence',
    status: 'failed',
    ok: false,
    errorKind: reportErrorKind(error),
  }));
  app.exit(1);
});

function reportErrorKind(error) {
  const kind = typeof error?.kind === 'string' ? error.kind : '';
  return /^web_[a-z0-9_]+$/u.test(kind) ? kind : 'unexpected_failure';
}
