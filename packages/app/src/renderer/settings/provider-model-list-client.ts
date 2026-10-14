// Reads the OpenAI-compatible model catalog of an endpoint the user is editing.
//
// "获取模型" has to work on a provider that does not exist yet, with an endpoint
// and a key that only exist as an unsaved draft in the editor. So this request is
// made by the Renderer straight to that endpoint, instead of going through Main:
// Main only knows saved providers, and routing the draft through it would persist
// a provider before the user decided to keep it.
//
// Consequences of that placement, both deliberate:
//   - the draft key is sent to the endpoint the user typed and to nothing else;
//   - the key is never put into a URL, an error message, or a log line.

import type { ProviderApiProtocol } from '@littlesheep/config'
import type { RuntimeProviderModel } from '../../shared/runtime-api-contracts'
import { DEFAULT_PROVIDER_PROTOCOL } from '../../shared/provider-protocols'

/** Server-supplied failures, mapped to what the user can act on. */
export type ProviderModelListFailure =
  /** The address is not a usable http(s) URL yet. */
  | 'invalid_url'
  /** No answer in time; the endpoint may be unreachable. */
  | 'timeout'
  /** DNS/connection/TLS failure, or a blocked cross-origin request. */
  | 'network'
  /** The endpoint answered, but not with a model catalog. */
  | 'http'
  /** A well-formed answer that contains no usable model id. */
  | 'empty'

export type ProviderModelListResult =
  | { ok: true; models: RuntimeProviderModel[] }
  | { ok: false; failure: ProviderModelListFailure; detail: string }

export interface ProviderModelListRequest {
  baseURL: string
  /** Plaintext draft key; empty means "no credential". */
  apiKey?: string
  /**
   * Wire protocol the provider speaks. It decides how the credential travels
   * (`x-api-key` for Anthropic, bearer otherwise) — sending the wrong one produces a
   * 401 that reads like a bad key.
   */
  api?: ProviderApiProtocol
  signal?: AbortSignal
  timeoutMs?: number
}

/** Both are spelled out in the published contract (docs/reference/custom-model-providers.md). */
export const PROVIDER_MODEL_LIST_TIMEOUT_MS = 15_000
export const PROVIDER_MODEL_LIST_HEADER = 'x-littlesheep-model-discovery'

interface ModelListEntry {
  id: string
  created?: number
}

/**
 * Ask an endpoint for its model catalog.
 *
 * A reference key (`$MY_GW_API_KEY`) is not used here: Main owns that value and
 * the Renderer must not reach for another key than the one the user is editing.
 * Such a call still identifies itself with {@link PROVIDER_MODEL_LIST_HEADER}, so
 * a keyed endpoint answers 401 instead of a misleading "no models found".
 */
export async function fetchProviderModels(
  request: ProviderModelListRequest,
): Promise<ProviderModelListResult> {
  const url = modelListUrl(request.baseURL)
  if (!url) return { ok: false, failure: 'invalid_url', detail: '请先填写 API 地址。' }

  // The caller's signal (the editor closing) and our own deadline both have to
  // end the request, so they are combined rather than nested.
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), request.timeoutMs ?? PROVIDER_MODEL_LIST_TIMEOUT_MS)
  const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal
  const apiKey = (request.apiKey ?? '').trim()
  const authHeader = protocolAuthHeader(request.api ?? DEFAULT_PROVIDER_PROTOCOL)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        [PROVIDER_MODEL_LIST_HEADER]: '1',
        ...(apiKey ? { [authHeader]: authHeader === 'Authorization' ? `Bearer ${apiKey}` : apiKey } : {}),
      },
      signal,
    })
    if (!response.ok) {
      return {
        ok: false,
        failure: 'http',
        // Status only. A response body can echo the submitted key back, and this
        // detail is shown to the user and may end up in a bug report.
        detail: `接口返回 HTTP ${response.status}${describeHttpStatus(response.status)}`,
      }
    }
    const models = parseModelListPayload(await response.json().catch(() => null))
    if (models.length === 0) {
      return {
        ok: false,
        failure: 'empty',
        detail: '接口没有返回任何模型 ID。部分网关只在 /v1/models 提供目录，请确认 API 地址是否包含 /v1。',
      }
    }
    return { ok: true, models }
  } catch (error) {
    if (timeout.signal.aborted) {
      return {
        ok: false,
        failure: 'timeout',
        detail: `等待 ${Math.round((request.timeoutMs ?? PROVIDER_MODEL_LIST_TIMEOUT_MS) / 1000)} 秒没有响应，请确认服务在本机可访问。`,
      }
    }
    return { ok: false, failure: 'network', detail: describeNetworkError(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The catalog URL for a base URL, keeping the user's path intact.
 *
 * Base URLs in the wild are written both ways: `https://host/v1` (the OpenAI
 * convention, and what this app's templates use) and `https://host/v1/models`
 * copied from a request example. A base URL that already names a catalog is used
 * as written; anything else gets `/models` appended.
 */
export function modelListUrl(baseURL: string): string | null {
  const trimmed = baseURL.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const path = url.pathname.replace(/\/+$/u, '')
  url.pathname = /\/models$/u.test(path) ? path : `${path}/models`.replace(/\/{2,}/gu, '/')
  // The query string of a base URL is a routing concern; it never belongs on the catalog call.
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Read the model ids out of a catalog payload, newest first when the server
 * publishes `created` (OpenAI-compatible gateways usually do, and the recent
 * models are the ones a person is looking for).
 */
export function parseModelListPayload(payload: unknown): RuntimeProviderModel[] {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const entries: ModelListEntry[] = []
  const seen = new Set<string>()
  for (const item of data) {
    const record = item as { id?: unknown; created?: unknown } | null
    const id = typeof record?.id === 'string' ? record.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    entries.push({
      id,
      created: typeof record?.created === 'number' && Number.isFinite(record.created) ? record.created : undefined,
    })
  }
  entries.sort((left, right) => (right.created ?? 0) - (left.created ?? 0))
  // Only the id is known. Context window, output limit and reasoning options stay
  // unknown on purpose: the catalog does not state them, and guessing them would
  // turn an unverified number into a displayed fact.
  return entries.map((entry) => ({
    id: entry.id,
    name: entry.id,
    declared: true,
    reasoningOptions: [],
  }))
}

/**
 * The header this protocol carries its credential in.
 *
 * Mirrors `PROTOCOL_DESCRIPTORS` in `@littlesheep/llm` (the renderer cannot import
 * that package's runtime code). Anthropic authenticates with `x-api-key`, so a
 * bearer token there is rejected as a bad key rather than as a wrong header.
 */
function protocolAuthHeader(protocol: ProviderApiProtocol): string {
  return protocol === 'anthropic-messages' ? 'x-api-key' : 'Authorization'
}

function describeHttpStatus(status: number): string {
  if (status === 401 || status === 403) return '，密钥被拒绝或该接口不允许读取模型列表'
  if (status === 404) return '，该地址没有模型列表接口'
  if (status === 429) return '，请求过于频繁'
  return ''
}

function describeNetworkError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '请求已取消。'
  return '无法连接该地址，请确认地址、网络和该服务的 CORS 设置。'
}
