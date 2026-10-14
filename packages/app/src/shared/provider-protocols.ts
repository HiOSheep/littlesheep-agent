// The wire protocols a custom provider can be configured with, as the settings page
// presents them.
//
// The list is declared HERE rather than imported from `@littlesheep/config`, even
// though config owns the schema enum. Importing it as a value dragged config's
// Node-only loader (`node:fs`) into the renderer bundle and broke the build; a
// `import type` cannot supply a runtime array. So the renderer keeps its own copy
// and `provider-protocols.test.ts` asserts it matches config's list, which makes a
// divergence a test failure rather than a silently missing protocol in the UI.

import type { ProviderApiProtocol } from '@littlesheep/config'

/**
 * Must equal `PROVIDER_API_PROTOCOLS` in `@littlesheep/config`. The test in this
 * folder compares them, so adding a protocol on one side cannot go unnoticed.
 */
export const IMPLEMENTED_PROTOCOLS: readonly ProviderApiProtocol[] = [
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
]

export interface ProtocolOption {
  id: ProviderApiProtocol
  label: string
  /** One line on when to choose it. */
  hint: string
  /** Path appended to the base URL for chat/messages. Mirrors `PROTOCOL_DESCRIPTORS` in @littlesheep/llm. */
  path: string
  /** True when this is the default for a new provider. */
  isDefault: boolean
}

export const PROVIDER_PROTOCOL_OPTIONS: readonly ProtocolOption[] = [
  {
    id: 'openai-chat-completions',
    label: 'OpenAI Chat Completions',
    hint: '最通用的 OpenAI 兼容接口：多数网关、Ollama、vLLM 都支持。',
    path: '/chat/completions',
    isDefault: true,
  },
  {
    id: 'openai-responses',
    label: 'OpenAI Responses',
    hint: 'OpenAI 较新的 Responses 接口；模型与网关是否支持需要自行确认。',
    path: '/responses',
    isDefault: false,
  },
  {
    id: 'anthropic-messages',
    label: 'Anthropic Messages',
    hint: 'Anthropic 原生 Messages 接口；也用于提供 Anthropic 兼容入口的网关。',
    path: '/messages',
    isDefault: false,
  },
]

export const DEFAULT_PROVIDER_PROTOCOL: ProviderApiProtocol = 'openai-chat-completions'

export function protocolLabel(protocol: ProviderApiProtocol): string {
  return PROVIDER_PROTOCOL_OPTIONS.find((option) => option.id === protocol)?.label ?? protocol
}

export function protocolHint(protocol: ProviderApiProtocol): string {
  return PROVIDER_PROTOCOL_OPTIONS.find((option) => option.id === protocol)?.hint ?? ''
}

/** The path LS appends to the base URL for this protocol, shown next to the address field. */
export function protocolPath(protocol: ProviderApiProtocol): string {
  return PROVIDER_PROTOCOL_OPTIONS.find((option) => option.id === protocol)?.path ?? ''
}

export function isKnownProtocol(value: string): value is ProviderApiProtocol {
  return (IMPLEMENTED_PROTOCOLS as readonly string[]).includes(value)
}
