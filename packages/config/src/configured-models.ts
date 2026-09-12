// @littlesheep/config — configured-models.ts
// Registry for user-declared model metadata (custom providers and custom
// models on preset providers).
//
// Authority model: the built-in registry in model-capabilities.ts keeps
// official provider facts. Entries here are the user's own declarations and
// are only consulted for models the built-in registry does not know, so a
// user entry can never overwrite a verified fact. Anything the user leaves
// undeclared stays unknown rather than being guessed.

import { resolveProviderModels } from './provider-models.js';
import type { Config } from './schema.js';
import type { RuntimeReasoning } from './model-capabilities.js';

export interface ConfiguredModelCapability {
  providerId: string;
  modelId: string;
  name?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  reasoningOptions?: readonly RuntimeReasoning[];
  ultraEffort?: 'high' | 'xhigh' | 'max';
  vision?: boolean;
  sourceUrl?: string;
}

const configuredModels = new Map<string, ConfiguredModelCapability>();

/** Replace the registry with the declarations of the given config. */
export function registerConfiguredModelCapabilities(config: Pick<Config, 'providers'>): void {
  configuredModels.clear();
  for (const provider of config.providers ?? []) {
    for (const model of resolveProviderModels(provider)) {
      if (!model.declared) continue;
      configuredModels.set(configuredModelRefKey(provider.id, model.id), {
        providerId: provider.id.trim().toLowerCase(),
        modelId: model.id,
        name: model.name,
        maxContextTokens: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        reasoningOptions: model.reasoningOptions,
        ultraEffort: model.ultraEffort,
        vision: model.vision,
        sourceUrl: model.sourceUrl,
      });
    }
  }
}

export function clearConfiguredModelCapabilities(): void {
  configuredModels.clear();
}

export function resolveConfiguredModelCapability(
  providerId: string,
  model: string,
): ConfiguredModelCapability | undefined {
  return configuredModels.get(configuredModelRefKey(providerId, model));
}

export function configuredModelRefKey(providerId: string, model: string): string {
  return `${normalizeConfiguredProvider(providerId)}/${normalizeConfiguredModel(model)}`;
}

function normalizeConfiguredProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'zhipu' || normalized === 'zai' ? 'glm' : normalized;
}

function normalizeConfiguredModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  const bracket = normalized.indexOf('[');
  return bracket > 0 ? normalized.slice(0, bracket) : normalized;
}
