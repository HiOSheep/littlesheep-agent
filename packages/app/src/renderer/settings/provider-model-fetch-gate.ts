// When 获取模型 may run, and what it says when it may not.
//
// The call carries only the key the user typed into the form, so the decision is
// really "does this draft have a usable credential right now". The three saved
// shapes below are the ones that get confused: "the provider requires a key" is a
// different question from "the keychain holds a key we could have reused".

import type { RuntimeProvider } from '../../shared/runtime-api-contracts'
import type { ProviderEditorDraft } from './model-provider-draft'

export interface ModelFetchGate {
  draft: ProviderEditorDraft | null
  /** A catalog request is already in flight. */
  fetching: boolean
  /** The saved provider this draft edits, or null while it does not exist yet. */
  savedProvider: RuntimeProvider | null
}

export function modelFetchBlockedReason(gate: ModelFetchGate): string | null {
  const { draft, savedProvider } = gate
  if (!draft) return null
  if (gate.fetching) return '正在获取模型…'
  const address = draft.baseURL.trim()
  if (!address) return '先填写 API 地址，才能读取模型列表。'
  if (!isHttpAddress(address)) return 'API 地址必须是 http(s) 地址。'
  if (draft.apiKey.trim()) return null
  // Nothing anywhere to send: a provider that needs no key (a local endpoint) or a
  // provider that does not exist yet (its key will be typed with the rest).
  if (!savedProvider?.requiresKey) return null
  // Only an entry the keychain owns can be described as stored: `derivingEnvVarName`
  // returns null for a literal key in config, and `hasKey` is false when the
  // referenced variable is unset. Either way the value is not one the UI could reuse.
  if (savedProvider.hasKey && savedProvider.envVar) {
    // The UI may name the entry because the value itself is never read back, which
    // is exactly what this sentence exists to explain.
    return `该供应商的密钥已保存在密钥库（${savedProvider.envVar}）。LS 不把密钥库内容读回界面，请在“API 密钥”里再填一次以获取模型。`
  }
  // Requires a key, and none is recoverable here: the reference is unset, or config
  // holds a literal key. Neither may be presented as "saved", and sending without a
  // credential would fail for a reason this panel never mentioned.
  return '该供应商需要密钥，而草稿里现在没有可用的密钥（LS 不会把已保存的密钥读回界面）。请在“API 密钥”里填一次再获取模型。'
}

function isHttpAddress(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
