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
  /**
   * True when the config entry carried metadata; false for a bare id. A bare id
   * means "the user listed this model but declared nothing", which is when the
   * assumed defaults apply.
   */
  declared?: boolean;
}

const configuredModels = new Map<string, ConfiguredModelCapability>();

/**
 * Replace the registry with the declarations of the given config.
 *
 * EVERY model a provider lists is registered, not only the ones written as metadata
 * objects. A bare id (`models: ["vendor-model"]`) is the user saying "this model
 * exists" while declaring nothing about it, which is exactly the case the defaults
 * exist for: skipping it left such a model with no capability entry at all, so it
 * resolved to "unknown" and the provider was unusable until the user filled in
 * numbers they often cannot find.
 *
 * Built-in vendor facts still win — `resolveModelContextWindow` consults the
 * built-in registry first, so nothing here can overwrite a documented value.
 */
export function registerConfiguredModelCapabilities(config: Pick<Config, 'providers'>): void {
  configuredModels.clear();
  for (const provider of config.providers ?? []) {
    for (const model of resolveProviderModels(provider)) {
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
        // Records that this entry came from the user's provider list rather than
        // from a metadata object, so `assumed-default` can be attributed correctly.
        declared: model.declared,
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
