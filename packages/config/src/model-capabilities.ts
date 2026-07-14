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
  source: 'official-provider-doc' | 'builtin-model-registry';
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
  source: 'builtin-model-registry';
  sourceUrl?: string;
  verifiedAt: string;
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
const GLM_52_SOURCE = 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2';

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
  'glm/glm-5.2',
  'glm/glm-5.1',
  'glm/glm-5',
  'glm/glm-5-turbo',
] as const;

const MODEL_TOKENIZER_CAPABILITIES = new Map<string, ModelTokenizerCapability>(
  BUILTIN_TOKENIZER_MODELS.map((modelRef) => [modelRef, unavailableTokenizer(modelRef)]),
);

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
  if (reasoning === 'auto') return {};

  const provider = normalizeProvider(providerId);
  const modelId = normalizeModel(model);
  const capability = MODEL_CAPABILITIES.get(`${provider}/${modelId}`);
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
  if (!capability) return undefined;
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
  return MODEL_TOKENIZER_CAPABILITIES.get(
    `${normalizeProvider(providerId)}/${normalizeModel(model)}`,
  );
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
