// Pure draft model for the provider editor: conversions between the runtime
// provider payload and an editable form, plus validation. No React and no
// fetch, so the settings page can unit-test its rules directly.

import {
  RUNTIME_REASONINGS,
  type RuntimeReasoning,
} from '../../shared/model-capabilities'
import type {
  ProviderDraft,
  ProviderModelDraft,
  RuntimeProvider,
  RuntimeProviderModel,
} from '../../shared/runtime-api-contracts'

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export const REASONING_LABELS: Record<RuntimeReasoning, string> = {
  auto: '自动',
  low: '低',
  medium: '中',
  high: '高',
  ultra: '极致',
}

/**
 * Endpoint templates for common OpenAI-compatible services. A template only
 * pre-fills the id, name and base URL: model ids are never invented, so the
 * user always types the exact model name their account can call.
 */
export interface ProviderTemplate {
  id: string
  name: string
  baseURL: string
  note: string
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  { id: 'openrouter', name: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', note: '聚合多家模型' },
  { id: 'moonshot', name: 'Moonshot / Kimi', baseURL: 'https://api.moonshot.cn/v1', note: 'Kimi 系列' },
  { id: 'dashscope', name: '阿里云百炼 / Qwen', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', note: '通义千问兼容模式' },
  { id: 'siliconflow', name: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', note: '聚合开源模型' },
  { id: 'ollama', name: 'Ollama（本地）', baseURL: 'http://127.0.0.1:11434/v1', note: '本机运行' },
  { id: 'lmstudio', name: 'LM Studio（本地）', baseURL: 'http://127.0.0.1:1234/v1', note: '本机运行' },
  { id: 'vllm', name: 'vLLM（本地）', baseURL: 'http://127.0.0.1:8000/v1', note: '自建推理服务' },
]

export interface ModelDraftRow {
  id: string
  name: string
  contextWindow: string
  maxOutputTokens: string
  reasoningOptions: RuntimeReasoning[]
}

export interface ProviderEditorDraft {
  id: string
  name: string
  baseURL: string
  /** Plaintext key typed by the user; empty keeps the stored reference. */
  apiKey: string
  models: ModelDraftRow[]
  /** Id of the provider being edited, or null when creating a new one. */
  originalId: string | null
}

export interface ProviderEditorValidation {
  error: string | null
  field: 'id' | 'baseURL' | 'models' | null
}

export function createEmptyProviderDraft(): ProviderEditorDraft {
  return {
    id: '',
    name: '',
    baseURL: '',
    apiKey: '',
    models: [createEmptyModelRow()],
    originalId: null,
  }
}

/**
 * A provider belongs on the settings page once the user has actually
 * configured it: it carries a saved key, needs no key at all (a local
 * endpoint), or was created by the user as a custom provider. Unconfigured
 * built-in presets stay in the add-provider picker instead of the list.
 */
export function isConfiguredProvider(provider: RuntimeProvider): boolean {
  return !provider.requiresKey || provider.hasKey || !provider.builtin
}

export function createProviderDraftFromTemplate(template: ProviderTemplate): ProviderEditorDraft {
  return {
    ...createEmptyProviderDraft(),
    id: template.id,
    name: template.name,
    baseURL: template.baseURL,
  }
}

export function createEmptyModelRow(): ModelDraftRow {
  return {
    id: '',
    name: '',
    contextWindow: '',
    maxOutputTokens: '',
    reasoningOptions: [],
  }
}

export function draftFromRuntimeProvider(provider: RuntimeProvider): ProviderEditorDraft {
  return {
    id: provider.id,
    name: provider.name === provider.id ? '' : provider.name,
    baseURL: provider.baseURL,
    apiKey: '',
    models: provider.models.map(modelRowFromRuntimeModel),
    originalId: provider.id,
  }
}

export function modelRowFromRuntimeModel(model: RuntimeProviderModel): ModelDraftRow {
  const declaredName = model.declared && model.name !== model.id ? model.name : ''
  return {
    id: model.id,
    name: declaredName,
    contextWindow: model.contextWindow ? String(model.contextWindow) : '',
    maxOutputTokens: model.maxOutputTokens ? String(model.maxOutputTokens) : '',
    reasoningOptions: [...model.reasoningOptions],
  }
}

export function validateProviderDraft(
  draft: ProviderEditorDraft,
  existingIds: readonly string[],
): ProviderEditorValidation {
  const id = draft.id.trim()
  if (!id) return { error: '请填写供应商 ID。', field: 'id' }
  if (!PROVIDER_ID_PATTERN.test(id)) {
    return { error: '供应商 ID 只能使用小写字母、数字、"-"、"_" 和 "."，且以字母或数字开头。', field: 'id' }
  }
  if (draft.originalId === null && existingIds.includes(id)) {
    return { error: `供应商 "${id}" 已存在。`, field: 'id' }
  }

  const baseURL = draft.baseURL.trim()
  if (!baseURL) return { error: '请填写 API 地址。', field: 'baseURL' }
  if (!isHttpUrl(baseURL)) return { error: 'API 地址必须是 http(s) URL。', field: 'baseURL' }

  const models = draft.models.filter((row) => row.id.trim().length > 0)
  for (const row of models) {
    const idError = validateModelRow(row)
    if (idError) return { error: idError, field: 'models' }
  }
  if (hasDuplicateModelIds(models)) {
    return { error: '模型 ID 不能重复。', field: 'models' }
  }
  return { error: null, field: null }
}

/** Build the request body; empty numbers and names are omitted, never zeroed. */
export function toProviderDraft(draft: ProviderEditorDraft): ProviderDraft {
  const models: ProviderModelDraft[] = []
  for (const row of draft.models) {
    const id = row.id.trim()
    if (!id) continue
    const model: ProviderModelDraft = { id }
    const name = row.name.trim()
    if (name) model.name = name
    const contextWindow = parsePositiveInteger(row.contextWindow)
    if (contextWindow !== undefined) model.contextWindow = contextWindow
    const maxOutputTokens = parsePositiveInteger(row.maxOutputTokens)
    if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens
    // "auto only" is the implicit default, so it is never sent as a
    // declaration; anything else is an explicit user choice.
    const declaredReasoning = row.reasoningOptions.length > 1
      || (row.reasoningOptions.length === 1 && row.reasoningOptions[0] !== 'auto')
    if (declaredReasoning) model.reasoningOptions = [...row.reasoningOptions]
    models.push(model)
  }
  const provider: ProviderDraft = {
    id: draft.id.trim(),
    baseURL: draft.baseURL.trim(),
    models,
  }
  const name = draft.name.trim()
  if (name) provider.name = name
  const apiKey = draft.apiKey.trim()
  if (apiKey) provider.apiKey = apiKey
  return provider
}

export function toggleReasoningOption(
  options: readonly RuntimeReasoning[],
  value: RuntimeReasoning,
): RuntimeReasoning[] {
  return RUNTIME_REASONINGS.filter((reasoning) =>
    reasoning === value
      ? !options.includes(value)
      : options.includes(reasoning),
  )
}

export function formatTokenCount(tokens: number | undefined): string {
  if (!tokens) return '未声明'
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(0))}K`
  return String(tokens)
}

function validateModelRow(row: ModelDraftRow): string | null {
  const id = row.id.trim()
  if (id.length > 200) return '模型 ID 过长。'
  if (!isPositiveIntegerField(row.contextWindow)) return `模型 "${id}" 的上下文窗口必须是正整数。`
  if (!isPositiveIntegerField(row.maxOutputTokens)) return `模型 "${id}" 的最大输出必须是正整数。`
  return null
}

function hasDuplicateModelIds(rows: readonly ModelDraftRow[]): boolean {
  const seen = new Set<string>()
  for (const row of rows) {
    const id = row.id.trim().toLowerCase()
    if (seen.has(id)) return true
    seen.add(id)
  }
  return false
}

function isPositiveIntegerField(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  return parsePositiveInteger(trimmed) !== undefined
}

function parsePositiveInteger(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
