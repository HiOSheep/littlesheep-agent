export const RUNTIME_REASONINGS = ['auto', 'low', 'medium', 'high', 'ultra'] as const

export type RuntimeReasoning = typeof RUNTIME_REASONINGS[number]

const AUTO_ONLY: readonly RuntimeReasoning[] = ['auto']
const LOW_MEDIUM_HIGH: readonly RuntimeReasoning[] = ['auto', 'low', 'medium', 'high']
const LOW_MEDIUM_HIGH_ULTRA: readonly RuntimeReasoning[] = ['auto', 'low', 'medium', 'high', 'ultra']
const HIGH_ULTRA: readonly RuntimeReasoning[] = ['auto', 'high', 'ultra']

export function isRuntimeReasoning(value: string): value is RuntimeReasoning {
  return (RUNTIME_REASONINGS as readonly string[]).includes(value)
}

export function getSupportedReasoningOptionsForModelRef(modelRef: string): readonly RuntimeReasoning[] {
  const { providerId, model } = splitModelRef(modelRef)
  return getSupportedReasoningOptions(providerId, model)
}

export function getSupportedReasoningOptions(providerId: string, model: string): readonly RuntimeReasoning[] {
  const provider = providerId.trim().toLowerCase()
  const modelId = model.trim().toLowerCase()

  if (provider === 'openai') {
    if (modelId === 'gpt-5.5' || modelId === 'gpt-5.5-pro' || modelId === 'gpt-5.4') {
      return LOW_MEDIUM_HIGH_ULTRA
    }
    if (modelId.startsWith('gpt-5.2') || modelId.startsWith('gpt-5.1') || modelId === 'gpt-5') {
      return LOW_MEDIUM_HIGH
    }
    if (modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')) {
      return LOW_MEDIUM_HIGH
    }
    return AUTO_ONLY
  }

  if (provider === 'deepseek') {
    if (
      modelId === 'deepseek-v4-pro' ||
      modelId === 'deepseek-v4-flash' ||
      modelId === 'deepseek-reasoner' ||
      modelId.includes('reasoner') ||
      modelId.includes('r1')
    ) {
      return HIGH_ULTRA
    }
    return AUTO_ONLY
  }

  if (provider === 'glm' || provider === 'zai' || provider === 'zhipu') {
    if (modelId === 'glm-5.2' || modelId.startsWith('glm-5.2[')) {
      return HIGH_ULTRA
    }
    return AUTO_ONLY
  }

  return AUTO_ONLY
}

export function coerceReasoningForModelRef(reasoning: RuntimeReasoning, modelRef: string): RuntimeReasoning {
  const supported = getSupportedReasoningOptionsForModelRef(modelRef)
  return supported.includes(reasoning) ? reasoning : 'auto'
}

export function isReasoningSupportedForModelRef(reasoning: RuntimeReasoning, modelRef: string): boolean {
  return getSupportedReasoningOptionsForModelRef(modelRef).includes(reasoning)
}

export function getContextWindowForModelRef(modelRef: string | undefined): number {
  const { providerId, model } = splitModelRef(modelRef ?? '')
  return getContextWindowTokens(providerId, model)
}

export function getContextWindowTokens(providerId: string, model: string): number {
  const provider = providerId.trim().toLowerCase()
  const modelId = model.trim().toLowerCase()

  if (provider === 'openai') {
    if (modelId === 'gpt-5.5' || modelId === 'gpt-5.5-pro') return 1_000_000
    if (modelId === 'gpt-5.4' || modelId.startsWith('gpt-5.2') || modelId.startsWith('gpt-5.1') || modelId === 'gpt-5') {
      return 400_000
    }
    if (modelId.startsWith('gpt-4.1')) return 1_000_000
    return 128_000
  }

  if (provider === 'deepseek') {
    if (modelId.startsWith('deepseek-v4')) return 1_000_000
    return 128_000
  }

  if (provider === 'glm' || provider === 'zai' || provider === 'zhipu') {
    if (modelId === 'glm-5.2' || modelId.startsWith('glm-5.2[')) return 1_000_000
    return 128_000
  }

  if (modelId.includes('1m') || modelId.includes('1000k')) return 1_000_000
  if (modelId.includes('400k')) return 400_000
  if (modelId.includes('256k')) return 256_000
  if (modelId.includes('128k')) return 128_000
  if (modelId.includes('32k')) return 32_000
  return 128_000
}

function splitModelRef(ref: string): { providerId: string; model: string } {
  const idx = ref.indexOf('/')
  if (idx < 0) return { providerId: '', model: ref }
  return { providerId: ref.slice(0, idx), model: ref.slice(idx + 1) }
}
