// @littlesheep/config — model-capabilities.ts
// Built-in provider/model capability registry: context window, max output,
// runtime reasoning options, provider reasoning request mapping, and exact or
// unavailable tokenizer status. Every value here is sourced from official
// provider documentation; user-declared model metadata is registered
// separately (configured-models.ts) and never overwrites these facts.

import { resolveConfiguredModelCapability } from './configured-models.js';

export const RUNTIME_REASONINGS = ['auto', 'low', 'medium', 'high', 'ultra'] as const;

export type RuntimeReasoning = typeof RUNTIME_REASONINGS[number];
export type ProviderReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface ModelContextWindowCapability {
  maxContextTokens: number;
  maxOutputTokens?: number;
  source: 'official-provider-doc' | 'builtin-model-registry' | 'user-config';
  sourceUrl?: string;
  verifiedAt?: string;
}

export interface ExactModelTokenizerCapability {
  status: 'exact';
  /** Must match the runtime ExactContextTokenCounter implementation id. */
  counterId: string;
  /** Exactness covers model tokenization plus message/tool framing for this request shape. */
  requestFormat: 'openai-compatible-chat-completions';
  source: 'official-provider-doc' | 'builtin-model-registry';
  sourceUrl?: string;
  verifiedAt: string;
}

export interface UnavailableModelTokenizerCapability {
  status: 'unavailable';
  reasonCode: 'no-verified-final-request-counter';
  reason: string;
  source: 'builtin-model-registry' | 'user-config';
  sourceUrl?: string;
  verifiedAt?: string;
}

export type ModelTokenizerCapability =
  | ExactModelTokenizerCapability
  | UnavailableModelTokenizerCapability;

export interface ProviderReasoningRequestOptions {
  reasoningEffort?: ProviderReasoningEffort;
  thinking?: {
    type: 'enabled' | 'disabled';
    clearThinking?: boolean;
  };
}

interface ModelCapabilityRecord extends ModelContextWindowCapability {
  reasoningOptions: readonly RuntimeReasoning[];
  highestEffort?: 'xhigh' | 'max';
  thinkingControl?: boolean;
}

const AUTO_ONLY: readonly RuntimeReasoning[] = ['auto'];
const AUTO_MEDIUM_HIGH_ULTRA: readonly RuntimeReasoning[] = ['auto', 'medium', 'high', 'ultra'];
const LOW_MEDIUM_HIGH_ULTRA: readonly RuntimeReasoning[] = ['auto', 'low', 'medium', 'high', 'ultra'];
const HIGH_ULTRA: readonly RuntimeReasoning[] = ['auto', 'high', 'ultra'];
const VERIFIED_AT = '2026-07-13';

const OPENAI_56_SOURCE = 'https://developers.openai.com/api/docs/models';
const OPENAI_55_SOURCE = 'https://developers.openai.com/api/docs/models/gpt-5.5';
const OPENAI_55_PRO_SOURCE = 'https://developers.openai.com/api/docs/models/gpt-5.5-pro';
const OPENAI_54_SOURCE = 'https://developers.openai.com/api/docs/models/gpt-5.4';
const OPENAI_52_SOURCE = 'https://developers.openai.com/api/docs/models/gpt-5.2';
const OPENAI_41_SOURCE = 'https://developers.openai.com/api/docs/models/gpt-4.1';
const DEEPSEEK_V4_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing';
const DEEPSEEK_V4_ENCODING_SOURCE = 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/tree/60d8d70770c6776ff598c94bb586a859a38244f1/encoding';
/**
 * 2026-09-10: DeepSeek released V4.1 Flash as the canonical Flash model and
 * retired V4 Flash. `deepseek-flash` is the supported name; the legacy
 * `deepseek-v4-flash` name is temporarily routed to the same V4.1 model, and
 * `deepseek-v4-pro` is scheduled to be routed to V4.1 Flash from 12:00
 * Beijing time on 2026-09-14. V4.1 ships its own encoding, so the V4 exact
 * counter below must not be claimed for any V4.1-served name.
 */
const DEEPSEEK_V41_CHANGELOG_SOURCE = 'https://api-docs.deepseek.com/updates/';
const DEEPSEEK_V41_ENCODING_SOURCE = 'https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/tree/dba1be0a40aa45a94ad051997016db3960a90277/encoding';
const GLM_52_SOURCE = 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2';

export const DEEPSEEK_V4_TOKEN_COUNTER_ID = 'deepseek-v4-provider-calibrated-tokenizer-v2';

/**
 * V4.1 ships its own tokenizer; the exactness of this counter is verified by
 * the live calibration matrix (five request shapes, zero delta) against
 * `deepseek-ai/DeepSeek-V4.1-Flash`.
 */
export const DEEPSEEK_V41_TOKEN_COUNTER_ID = 'deepseek-v41-provider-calibrated-tokenizer-v1';

const MODEL_CAPABILITIES = new Map<string, ModelCapabilityRecord>([
  ...['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map((model) => [
    `openai/${model}`,
    capability(1_050_000, 128_000, LOW_MEDIUM_HIGH_ULTRA, 'max', OPENAI_56_SOURCE),
  ] as const),
  ['openai/gpt-5.5', capability(1_050_000, 128_000, LOW_MEDIUM_HIGH_ULTRA, 'xhigh', OPENAI_55_SOURCE)],
  ['openai/gpt-5.5-pro', capability(1_050_000, 128_000, AUTO_MEDIUM_HIGH_ULTRA, 'xhigh', OPENAI_55_PRO_SOURCE)],
  ['openai/gpt-5.4', capability(1_050_000, 128_000, LOW_MEDIUM_HIGH_ULTRA, 'xhigh', OPENAI_54_SOURCE)],
  ['openai/gpt-5.2', capability(400_000, 128_000, LOW_MEDIUM_HIGH_ULTRA, 'xhigh', OPENAI_52_SOURCE)],
  ['openai/gpt-4.1', capability(1_047_576, 32_768, AUTO_ONLY, undefined, OPENAI_41_SOURCE)],
  ['deepseek/deepseek-v4-pro', capability(1_000_000, 384_000, HIGH_ULTRA, 'max', DEEPSEEK_V4_SOURCE, true)],
  ['deepseek/deepseek-v4-flash', capability(1_000_000, 384_000, HIGH_ULTRA, 'max', DEEPSEEK_V4_SOURCE, true)],
  ['deepseek/deepseek-flash', capability(1_000_000, 384_000, HIGH_ULTRA, 'max', DEEPSEEK_V41_CHANGELOG_SOURCE, true)],
  ['glm/glm-5.2', capability(1_000_000, 131_072, HIGH_ULTRA, 'max', GLM_52_SOURCE, true)],
]);

const BUILTIN_TOKENIZER_MODELS = [
  'openai/gpt-5.6',
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.5',
  'openai/gpt-5.5-pro',
  'openai/gpt-5.4',
  'openai/gpt-5.2',
  'openai/gpt-4.1',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-flash',
  'glm/glm-5.2',
  'glm/glm-5.1',
  'glm/glm-5',
  'glm/glm-5-turbo',
] as const;

const MODEL_TOKENIZER_CAPABILITIES = new Map<string, ModelTokenizerCapability>(
  BUILTIN_TOKENIZER_MODELS.map((modelRef) => [modelRef, unavailableTokenizer(modelRef)]),
);

// Only the still-V4-Pro name keeps the V4 exact counter. `deepseek-v4-flash`
// and `deepseek-flash` are served by the V4.1 architecture, whose prompt
// framing and encoding differ from the calibrated V4 assets.
for (const modelRef of ['deepseek/deepseek-v4-pro']) {
  MODEL_TOKENIZER_CAPABILITIES.set(modelRef, {
    status: 'exact',
    counterId: DEEPSEEK_V4_TOKEN_COUNTER_ID,
    requestFormat: 'openai-compatible-chat-completions',
    source: 'official-provider-doc',
    sourceUrl: DEEPSEEK_V4_ENCODING_SOURCE,
    verifiedAt: '2026-07-31',
  });
}

for (const modelRef of ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-flash']) {
  MODEL_TOKENIZER_CAPABILITIES.set(modelRef, {
    status: 'exact',
    counterId: DEEPSEEK_V41_TOKEN_COUNTER_ID,
    requestFormat: 'openai-compatible-chat-completions',
    source: 'official-provider-doc',
    sourceUrl: DEEPSEEK_V41_ENCODING_SOURCE,
    verifiedAt: '2026-09-11',
  });
}

export function isRuntimeReasoning(value: string): value is RuntimeReasoning {
  return (RUNTIME_REASONINGS as readonly string[]).includes(value);
}

export function getSupportedReasoningOptionsForModelRef(modelRef: string): readonly RuntimeReasoning[] {
  const { providerId, model } = splitModelRef(modelRef);
  return getSupportedReasoningOptions(providerId, model);
}

export function getSupportedReasoningOptions(providerId: string, model: string): readonly RuntimeReasoning[] {
  const provider = normalizeProvider(providerId);
  const modelId = normalizeModel(model);
  const exact = MODEL_CAPABILITIES.get(`${provider}/${modelId}`);
  if (exact) return exact.reasoningOptions;

  // User-declared models are the only authority LS has for names it does not
  // know; an undeclared model stays "auto" only.
  const configured = resolveConfiguredModelCapability(provider, modelId);
  if (configured?.reasoningOptions?.length) return configured.reasoningOptions;

  if (provider === 'openai' && (
    modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')
  )) {
    return ['auto', 'low', 'medium', 'high'];
  }
  if (provider === 'deepseek' && (modelId.includes('reasoner') || modelId.includes('r1'))) {
    return HIGH_ULTRA;
  }
  return AUTO_ONLY;
}

export function coerceReasoningForModelRef(reasoning: RuntimeReasoning, modelRef: string): RuntimeReasoning {
  const supported = getSupportedReasoningOptionsForModelRef(modelRef);
  return supported.includes(reasoning) ? reasoning : 'auto';
}

export function isReasoningSupportedForModelRef(reasoning: RuntimeReasoning, modelRef: string): boolean {
  return getSupportedReasoningOptionsForModelRef(modelRef).includes(reasoning);
}

export function resolveProviderReasoningRequest(
  providerId: string,
  model: string,
  reasoning: RuntimeReasoning,
): ProviderReasoningRequestOptions {
  const provider = normalizeProvider(providerId);
  const modelId = normalizeModel(model);
  const capability = MODEL_CAPABILITIES.get(`${provider}/${modelId}`);
  const configured = capability
    ? undefined
    : resolveConfiguredModelCapability(provider, modelId);
  if (reasoning !== 'auto' && !capability && configured?.reasoningOptions?.includes(reasoning)) {
    // OpenAI-compatible reasoning_effort is the only wire contract LS can
    // assume for a user-declared model; "ultra" uses the declared ceiling.
    const effort: ProviderReasoningEffort = reasoning === 'ultra'
      ? configured.ultraEffort ?? 'high'
      : reasoning as ProviderReasoningEffort;
    return { reasoningEffort: effort };
  }
  if (reasoning === 'auto') {
    // DeepSeek V4 changes prompt framing with thinking mode. Keep the default
    // low-cost path explicit so local accounting observes the request sent.
    return provider === 'deepseek' && capability?.thinkingControl
      ? { thinking: { type: 'disabled' } }
      : {};
  }
  if (!capability || !capability.reasoningOptions.includes(reasoning)) return {};

  const reasoningEffort: ProviderReasoningEffort = reasoning === 'ultra'
    ? capability.highestEffort ?? 'high'
    : reasoning;
  return {
    reasoningEffort,
    thinking: capability.thinkingControl ? { type: 'enabled' } : undefined,
  };
}

export function resolveModelContextWindow(
  providerId: string,
  model: string,
): ModelContextWindowCapability | undefined {
  const key = `${normalizeProvider(providerId)}/${normalizeModel(model)}`;
  const capability = MODEL_CAPABILITIES.get(key);
  if (!capability) {
    const configured = resolveConfiguredModelCapability(providerId, model);
    if (configured?.maxContextTokens === undefined) return undefined;
    return {
      maxContextTokens: configured.maxContextTokens,
      maxOutputTokens: configured.maxOutputTokens,
      source: 'user-config',
      sourceUrl: configured.sourceUrl,
    };
  }
  return {
    maxContextTokens: capability.maxContextTokens,
    maxOutputTokens: capability.maxOutputTokens,
    source: capability.source,
    sourceUrl: capability.sourceUrl,
    verifiedAt: capability.verifiedAt,
  };
}

export function resolveModelContextWindowForModelRef(
  modelRef: string | undefined,
): ModelContextWindowCapability | undefined {
  const { providerId, model } = splitModelRef(modelRef ?? '');
  return resolveModelContextWindow(providerId, model);
}

export function resolveModelTokenizerCapability(
  providerId: string,
  model: string,
): ModelTokenizerCapability | undefined {
  const exact = MODEL_TOKENIZER_CAPABILITIES.get(
    `${normalizeProvider(providerId)}/${normalizeModel(model)}`,
  );
  if (exact) return exact;
  const configured = resolveConfiguredModelCapability(providerId, model);
  if (!configured) return undefined;
  return {
    status: 'unavailable',
    reasonCode: 'no-verified-final-request-counter',
    reason: `${configured.providerId}/${configured.modelId} is declared by the user; LS has no verified counter that reproduces this model's final prompt tokens, so context usage keeps reporting no local count.`,
    source: 'user-config',
    sourceUrl: configured.sourceUrl,
  };
}

export function resolveModelTokenizerCapabilityForModelRef(
  modelRef: string | undefined,
): ModelTokenizerCapability | undefined {
  const { providerId, model } = splitModelRef(modelRef ?? '');
  return resolveModelTokenizerCapability(providerId, model);
}

/** UI compatibility helper. Unknown windows return 0 rather than a fabricated default. */
export function getContextWindowForModelRef(modelRef: string | undefined): number {
  return resolveModelContextWindowForModelRef(modelRef)?.maxContextTokens ?? 0;
}

export function getContextWindowTokens(providerId: string, model: string): number {
  return resolveModelContextWindow(providerId, model)?.maxContextTokens ?? 0;
}

function capability(
  maxContextTokens: number,
  maxOutputTokens: number,
  reasoningOptions: readonly RuntimeReasoning[],
  highestEffort: 'xhigh' | 'max' | undefined,
  sourceUrl: string,
  thinkingControl = false,
): ModelCapabilityRecord {
  return {
    maxContextTokens,
    maxOutputTokens,
    reasoningOptions,
    highestEffort,
    thinkingControl,
    source: 'official-provider-doc',
    sourceUrl,
    verifiedAt: VERIFIED_AT,
  };
}

function unavailableTokenizer(modelRef: string): UnavailableModelTokenizerCapability {
  return {
    status: 'unavailable',
    reasonCode: 'no-verified-final-request-counter',
    reason: `LS has not verified a client-side counter that reproduces final chat/completions prompt tokens for ${modelRef}, including message and tool framing.`,
    source: 'builtin-model-registry',
    sourceUrl: MODEL_CAPABILITIES.get(modelRef)?.sourceUrl,
    verifiedAt: VERIFIED_AT,
  };
}

function splitModelRef(ref: string): { providerId: string; model: string } {
  const idx = ref.indexOf('/');
  if (idx < 0) return { providerId: '', model: ref };
  return { providerId: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'zhipu' || normalized === 'zai' ? 'glm' : normalized;
}

function normalizeModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  const bracket = normalized.indexOf('[');
  return bracket > 0 ? normalized.slice(0, bracket) : normalized;
}
