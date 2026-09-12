// @littlesheep/config — provider-models.ts
// Normalizes a provider model list (bare ids or metadata objects) into one
// resolved shape and merges preset/user entries by id without dropping
// declared metadata. Pure data helpers: no I/O and no capability defaults.

import type { ModelEntry, ModelProvider } from './schema.js';
import type { RuntimeReasoning } from './model-capabilities.js';

/** A provider model with every optional field normalized. */
export interface ResolvedProviderModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningOptions?: readonly RuntimeReasoning[];
  ultraEffort?: 'high' | 'xhigh' | 'max';
  vision?: boolean;
  sourceUrl?: string;
  /** True when the config entry carried metadata instead of a bare id. */
  declared: boolean;
}

/** A model list entry as written in config. */
export type ProviderModelInput = string | ModelEntry;

export function resolveProviderModels(
  provider: Pick<ModelProvider, 'models'>,
): ResolvedProviderModel[] {
  return resolveProviderModelEntries(provider.models);
}

export function resolveProviderModelEntries(
  models: readonly ProviderModelInput[] | undefined,
): ResolvedProviderModel[] {
  const resolved: ResolvedProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of models ?? []) {
    const model = resolveProviderModelEntry(entry);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    resolved.push(model);
  }
  return resolved;
}

export function resolveProviderModelEntry(
  entry: ProviderModelInput,
): ResolvedProviderModel | null {
  if (typeof entry === 'string') {
    const id = entry.trim();
    return id ? { id, name: id, declared: false } : null;
  }
  const id = entry.id.trim();
  if (!id) return null;
  return {
    id,
    name: entry.name?.trim() || id,
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    reasoningOptions: entry.reasoningOptions,
    ultraEffort: entry.ultraEffort,
    vision: entry.vision,
    sourceUrl: entry.sourceUrl,
    declared: true,
  };
}

export function resolveProviderModelIds(
  provider: Pick<ModelProvider, 'models'>,
): string[] {
  return resolveProviderModels(provider).map((model) => model.id);
}

/**
 * Merge two model lists by id. The later list wins for metadata, but a bare
 * id never erases metadata declared by the other list.
 */
export function mergeProviderModelEntries(
  primary: readonly ProviderModelInput[] | undefined,
  secondary: readonly ProviderModelInput[] | undefined,
): ProviderModelInput[] {
  const merged: ProviderModelInput[] = [];
  const order: string[] = [];
  const byId = new Map<string, ResolvedProviderModel>();
  for (const entry of [...(primary ?? []), ...(secondary ?? [])]) {
    const model = resolveProviderModelEntry(entry);
    if (!model) continue;
    const previous = byId.get(model.id);
    if (!previous) order.push(model.id);
    byId.set(model.id, previous ? mergeResolvedModel(previous, model) : model);
  }
  for (const id of order) {
    const model = byId.get(id)!;
    merged.push(toProviderModelInput(model));
  }
  return merged;
}

function mergeResolvedModel(
  previous: ResolvedProviderModel,
  next: ResolvedProviderModel,
): ResolvedProviderModel {
  return {
    id: next.id,
    name: next.declared ? next.name : previous.name,
    contextWindow: next.contextWindow ?? previous.contextWindow,
    maxOutputTokens: next.maxOutputTokens ?? previous.maxOutputTokens,
    reasoningOptions: next.reasoningOptions ?? previous.reasoningOptions,
    ultraEffort: next.ultraEffort ?? previous.ultraEffort,
    vision: next.vision ?? previous.vision,
    sourceUrl: next.sourceUrl ?? previous.sourceUrl,
    declared: previous.declared || next.declared,
  };
}

/** Keep the config compact: bare ids stay bare, declared entries stay objects. */
function toProviderModelInput(model: ResolvedProviderModel): ProviderModelInput {
  if (!model.declared) return model.id;
  const entry: ModelEntry = { id: model.id };
  if (model.name !== model.id) entry.name = model.name;
  if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
  if (model.maxOutputTokens !== undefined) entry.maxOutputTokens = model.maxOutputTokens;
  if (model.reasoningOptions) entry.reasoningOptions = [...model.reasoningOptions];
  if (model.ultraEffort) entry.ultraEffort = model.ultraEffort;
  if (model.vision !== undefined) entry.vision = model.vision;
  if (model.sourceUrl) entry.sourceUrl = model.sourceUrl;
  return entry;
}
