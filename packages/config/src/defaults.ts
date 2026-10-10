// @littlesheep/config — defaults.ts
// Default config (used when no config file exists).

import { ConfigSchema, type Config, type ModelProvider } from './schema.js';
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

/** Generated from the schema so no-file loads share the validated defaults. */
export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

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
