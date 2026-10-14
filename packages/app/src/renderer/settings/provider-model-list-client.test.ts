// The model-catalog lookup is the one place where a Renderer request carries a
// plaintext key, so both the URL it builds and what it refuses to put into a
// message are pinned here.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROVIDER_MODEL_LIST_HEADER,
  fetchProviderModels,
  modelListUrl,
  parseModelListPayload,
} from './provider-model-list-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('model list URL', () => {
  it('appends /models to a versioned base URL and keeps a catalog URL as written', () => {
    expect(modelListUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models')
    expect(modelListUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/models')
    expect(modelListUrl('https://api.example.com')).toBe('https://api.example.com/models')
    expect(modelListUrl('https://api.example.com/v1/models')).toBe('https://api.example.com/v1/models')
    expect(modelListUrl('  http://127.0.0.1:11434/v1 ')).toBe('http://127.0.0.1:11434/v1/models')
  })

  it('drops a query string, which belongs to the base call and not to the catalog', () => {
    expect(modelListUrl('https://api.example.com/v1?key=leaked')).toBe('https://api.example.com/v1/models')
  })

  it('refuses addresses that cannot be called yet', () => {
    expect(modelListUrl('')).toBeNull()
    expect(modelListUrl('api.example.com/v1')).toBeNull()
    expect(modelListUrl('ftp://api.example.com/v1')).toBeNull()
  })
})

describe('model list payload', () => {
  it('keeps ids only: names, windows and reasoning stay undefined rather than guessed', () => {
    const models = parseModelListPayload({
      data: [
        { id: 'vendor-a', created: 10, context_window: 128000 },
        { id: 'vendor-b', created: 20 },
      ],
    })
    expect(models).toEqual([
      { id: 'vendor-b', name: 'vendor-b', declared: true, reasoningOptions: [] },
      { id: 'vendor-a', name: 'vendor-a', declared: true, reasoningOptions: [] },
    ])
  })

  it('puts the newest models first when the server publishes created', () => {
    const models = parseModelListPayload({
      data: [
        { id: 'old', created: 1 },
        { id: 'new', created: 3 },
        { id: 'middle', created: 2 },
      ],
    })
    expect(models.map((model) => model.id)).toEqual(['new', 'middle', 'old'])
  })

  it('survives a payload the endpoint shaped differently', () => {
    expect(parseModelListPayload(null)).toEqual([])
    expect(parseModelListPayload({ object: 'list' })).toEqual([])
    expect(parseModelListPayload({ data: 'vendor-model' })).toEqual([])
    expect(parseModelListPayload({ data: [{}, { id: '  ' }, { id: 42 }] })).toEqual([])
    expect(parseModelListPayload({ data: [{ id: 'dup' }, { id: 'dup' }] }).map((model) => model.id)).toEqual(['dup'])
  })
})

describe('fetchProviderModels', () => {
  it('sends the draft key to the typed address and identifies itself otherwise', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ data: [{ id: 'vendor-a' }] }), { status: 200 })
    })
    const result = await fetchProviderModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-draft' })
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'vendor-a', name: 'vendor-a', declared: true, reasoningOptions: [] }],
    })
    expect(calls[0]?.url).toBe('https://api.example.com/v1/models')
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer sk-draft',
      [PROVIDER_MODEL_LIST_HEADER]: '1',
    })
  })

  it('reports the status without repeating a body that may echo the key back', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'bad key sk-draft' }), { status: 401 }))
    const result = await fetchProviderModels({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-draft' })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ failure: 'http' })
    if (!result.ok) {
      expect(result.detail).toContain('401')
      expect(result.detail).not.toContain('sk-draft')
    }
  })

  it('calls an answer with no usable ids an empty catalog, not a success', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 }))
    const result = await fetchProviderModels({ baseURL: 'https://api.example.com/v1' })
    expect(result).toMatchObject({ ok: false, failure: 'empty' })
  })

  it('separates an unusable address, an unreachable endpoint and a timeout', async () => {
    expect(await fetchProviderModels({ baseURL: 'not a url' }))
      .toMatchObject({ ok: false, failure: 'invalid_url' })
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch') })
    expect(await fetchProviderModels({ baseURL: 'https://api.example.com/v1' }))
      .toMatchObject({ ok: false, failure: 'network' })
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    expect(await fetchProviderModels({ baseURL: 'https://api.example.com/v1', timeoutMs: 5 }))
      .toMatchObject({ ok: false, failure: 'timeout' })
  })

  it('ends the request when the caller cancels it', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const pending = fetchProviderModels({
      baseURL: 'https://api.example.com/v1',
      signal: controller.signal,
      timeoutMs: 60_000,
    })
    controller.abort()
    // The caller's own cancellation is not a server-side timeout.
    expect(await pending).toMatchObject({ ok: false, failure: 'network' })
  })
})
