// @littlesheep/config — defaults.ts
// Default config (used when no config file exists).

import type { Config, ModelProvider } from './schema.js';
import { mergeProviderModelEntries, resolveProviderModelIds } from './provider-models.js';

export const PROVIDER_PRESETS: ModelProvider[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKey: '$OPENAI_API_KEY',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-4.1'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKey: '$DEEPSEEK_API_KEY',
    // `deepseek-flash` is the canonical name for the current V4.1 Flash model.
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'],
  },
  {
    id: 'glm',
    name: 'GLM / Zhipu AI',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '$GLM_API_KEY',
    models: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo'],
  },
];

/** Default config. Matches ConfigSchema defaults. */
export const DEFAULT_CONFIG: Config = {
  version: 1,
  providers: [],
  agents: {
    defaults: {
      workspace: process.cwd(),
      model: 'openai/gpt-5.6',
      reasoning: 'auto',
      profile: 'general',
      timeoutSeconds: 172800,
      maxRecoveryAttempts: 3,
      timeFormat: 'auto',
      bootstrapMaxChars: 20000,
      bootstrapTotalMaxChars: 60000,
      contextCompressionThresholdRatio: 0.8,
      maxModelCallsPerRun: 32,
      harness: 'core-flow',
      durableHarnessMode: 'next',
      durableHarnessSessionOverrides: {},
      durableHarnessOriginOverrides: {},
      durableHarnessProfileOverrides: {},
    },
  },
  desktop: {
    closePolicy: 'background-while-active',
  },
  tools: {
    exec: {
      whitelist: [
        'git status', 'git log', 'git diff', 'git branch',
        'ls', 'dir', 'Get-ChildItem', 'pwd', 'echo',
        'node --version', 'npm --version', 'pnpm --version',
      ],
      blacklist: [
        'rm -rf /', 'format', 'mkfs', 'dd if=', 'shutdown', 'reboot',
      ],
      approvalMode: 'interactive',
    },
    maxOutputChars: 10000,
    stripImages: true,
    maxParallel: 4,
    invocationTimeoutMs: 120000,
  },
  memory: {
    repositoryBackend: 'v2' as const,
    preludeDays: 3,
    preludeMaxCharsPerDay: 2000,
    preludeTotalMaxChars: 8000,
    autoDistill: true,
    distillAfterDays: 7,
    searchMaxResults: 20,
    treeRunTokenBudget: 3200,
    treeBranchTokenBudget: 1200,
    treeRootIndexMaxChars: 1600,
    experienceWriteThreshold: 0.65,
    llmCapture: false,
    llmEvolve: 'adaptive',
    autoMemoryPolicy: 'compaction' as const,
    embeddingMode: 'local',
  },
  web: {
    enabled: false,
    readMode: 'public_anonymous',
    strictReadApproval: false,
    allowDomains: [],
    blockDomains: [],
    dnsResolver: 'system',
    maxQueryChars: 2_000,
    maxResults: 10,
    maxFetchesPerRun: 4,
    maxQueriesPerRun: 4,
    maxConcurrentRequests: 4,
    searchTimeoutMs: 15_000,
    fetchTimeoutMs: 20_000,
    totalTimeoutMs: 90_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxExtractedChars: 40_000,
    maxRedirects: 5,
    cache: {
      enabled: true,
      ttlSeconds: 300,
      maxBytes: 64 * 1024 * 1024,
    },
    browserFallback: 'approval_required',
    sensitiveQueryPolicy: 'approve',
    providers: [],
  },
  safety: {
    enabled: true,
    maxEntryChars: 500,
    quarantineDir: 'quarantine',
    blockInjectionPatterns: true,
    sanitizePrelude: true,
  },
  sessions: {
    writeLock: {
      acquireTimeoutMs: 60000,
    },
    compaction: {
      threshold: 100,
      keepRecent: 20,
      background: false,
    },
  },
  skills: {
    extraDirs: [],
    disabled: [],
  },
  plugins: {
    disabled: [],
    extraDirs: [],
    allowLocalCode: false,
  },
  mcp: {
    servers: [],
  },
  channels: {
    channels: [],
  },
  versioning: {
    enabled: true,
    maxCheckpoints: 256,
    maxFileBytes: 8 * 1024 * 1024,
    maxWorkspaceFiles: 20000,
    maxWorkspaceBytes: 512 * 1024 * 1024,
  },
};

export function withProviderPresets(config: Config): Config {
  const presetsById = new Map(PROVIDER_PRESETS.map((p) => [p.id, p]));
  const existing = new Set(config.providers.map((p) => p.id));
  return {
    ...config,
    providers: [
      ...config.providers.map((provider) => {
        const preset = presetsById.get(provider.id);
        if (!preset) return provider;
        return {
          ...provider,
          name: provider.name ?? preset.name,
          apiKey: provider.apiKey ?? preset.apiKey,
          timeoutSeconds: provider.timeoutSeconds ?? preset.timeoutSeconds,
          models: mergeProviderModelEntries(preset.models, provider.models),
        };
      }),
      ...PROVIDER_PRESETS.filter((p) => !existing.has(p.id)),
    ],
  };
}

export function modelRefForProvider(provider: ModelProvider): string {
  return `${provider.id}/${resolveProviderModelIds(provider)[0] ?? 'chat'}`;
}

export function selectDefaultModelForAvailableProvider(
  config: Config,
  hasApiKey: (provider: ModelProvider) => boolean,
): string {
  const [currentProviderId, currentModel] = config.agents.defaults.model.split('/');
  const currentProvider = config.providers.find((p) => p.id === currentProviderId);
  if (currentProvider && hasApiKey(currentProvider)) {
    const modelIds = resolveProviderModelIds(currentProvider);
    if (modelIds.length && currentModel && !modelIds.includes(currentModel)) {
      return modelRefForProvider(currentProvider);
    }
    return config.agents.defaults.model;
  }
  const available = config.providers.find(hasApiKey);
  return available ? modelRefForProvider(available) : config.agents.defaults.model;
}

/** Historical helper name kept for callers; now returns all built-in provider presets. */
export function defaultConfigWithOpenAI(apiKey?: string): Config {
  const config = withProviderPresets(DEFAULT_CONFIG);
  if (!apiKey) return config;
  return {
    ...config,
    providers: config.providers.map((p) =>
      p.id === 'openai' ? { ...p, apiKey } : p,
    ),
  };
}
