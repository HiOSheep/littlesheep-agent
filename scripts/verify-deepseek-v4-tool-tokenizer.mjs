import { app, safeStorage } from 'electron'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBranding, resolveDataDir } from '../packages/branding/dist/index.js'
import {
  getProvider,
  loadConfig,
  resolveApiKey,
} from '../packages/config/dist/index.js'
import {
  prepareLocalExactContextTokenCounter,
} from '../packages/context/dist/index.js'
import { createLlmClient } from '../packages/llm/dist/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SINGLE_TOOL = {
  type: 'function',
  function: {
    name: 'calibration_probe',
    description: 'Return a deterministic calibration value.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', enum: ['alpha-42'] },
      },
      required: ['value'],
      additionalProperties: false,
    },
  },
}

const MULTI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'calibration_glob',
      description: 'Return deterministic paths for a pattern.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['path', 'limit'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calibration_search',
      description: 'Return deterministic matches for a query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          caseSensitive: { type: 'boolean' },
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['query', 'caseSensitive', 'paths'],
        additionalProperties: false,
      },
    },
  },
]

async function main() {
  const args = parseArgs(process.argv.slice(2))
  app.setPath('userData', resolveChromiumUserDataDir())
  await app.whenReady()

  const branding = await loadBranding(join(repoRoot, 'branding.config.json'))
  const dataDir = resolveDataDir(branding)
  injectKeys(await loadEncryptedKeys(dataDir))
  const config = await loadConfig({ dataDir })
  const providerId = args.provider ?? configuredProviderId(config.agents.defaults.model)
  const provider = getProvider(config, providerId)
  if (!provider) throw new Error(`Provider ${providerId} is not configured.`)
  const model = args.model ?? configuredModel(config.agents.defaults.model, provider.id) ?? provider.models?.[0]
  if (!model) throw new Error(`Provider ${provider.id} has no configured model.`)
  if (!['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'].includes(model.toLowerCase())) {
    throw new Error(`Model ${model} is not covered by a calibrated DeepSeek tokenizer family.`)
  }
  const apiKey = resolveApiKey(provider.apiKey)
  if (!apiKey) throw new Error(`Provider ${provider.id} has no usable API key.`)

  // The tool-protocol matrix is calibrated for the V4.1 family; the V4 Pro
  // family only owns plain/thinking shapes.
  if (!['deepseek-flash', 'deepseek-v4-flash'].includes(model.toLowerCase())) {
    throw new Error(
      `Tool protocol exact counting is calibrated for the V4.1 family (deepseek-flash, deepseek-v4-flash); ${model} is not covered.`,
    )
  }
  const counter = await prepareLocalExactContextTokenCounter({
    modelRef: `${provider.id}/${model}`,
    modelRootDir: join(dataDir, 'models', 'tokenizer'),
  })
  if (!counter) throw new Error(`No exact local counter is registered for ${provider.id}/${model}.`)
  const client = createLlmClient({
    baseURL: provider.baseURL,
    apiKey,
    timeoutSeconds: args.timeoutSeconds,
  }, {
    retry: { maxAttempts: 1 },
  })

  const results = []
  for (const mode of [
    { id: 'disabled', thinking: { type: 'disabled', clear_thinking: true } },
    { id: 'high', reasoning_effort: 'high', thinking: { type: 'enabled', clear_thinking: true } },
    { id: 'max', reasoning_effort: 'max', thinking: { type: 'enabled', clear_thinking: true } },
  ]) {
    const direct = await calibrate({
      name: `direct-${mode.id}`,
      request: {
        model,
        messages: [{ role: 'user', content: 'Reply with the single word CALIBRATED.' }],
        max_tokens: 256,
        reasoning_effort: mode.reasoning_effort,
        thinking: mode.thinking,
      },
      client,
      counter,
    })
    results.push(direct.result)

    const initialRequest = {
      model,
      messages: [{
        role: 'user',
        content: 'Call calibration_probe exactly once with value alpha-42. Do not answer directly.',
      }],
      tools: [SINGLE_TOOL],
      tool_choice: 'auto',
      max_tokens: 512,
      reasoning_effort: mode.reasoning_effort,
      thinking: mode.thinking,
    }
    const initial = await calibrate({
      name: `schema-only-${mode.id}`,
      request: initialRequest,
      client,
      counter,
    })
    results.push(initial.result)

    if (initial.result.status !== 'covered') continue
    const calls = initial.response.toolCalls.filter((call) => call.function.name === 'calibration_probe')
    if (calls.length !== 1) {
      throw new Error(`schema-only-${mode.id} expected one calibration_probe call, received ${calls.length}.`)
    }
    const parsedArguments = parseObject(calls[0].function.arguments)
    if (parsedArguments?.value !== 'alpha-42') {
      throw new Error(`schema-only-${mode.id} returned invalid calibration_probe arguments.`)
    }

    const continuationRequest = {
      ...initialRequest,
      messages: [
        ...initialRequest.messages,
        {
          role: 'assistant',
          content: initial.response.content,
          reasoning_content: initial.response.reasoningContent,
          tool_calls: initial.response.toolCalls,
        },
        {
          role: 'tool',
          tool_call_id: calls[0].id,
          name: calls[0].function.name,
          content: JSON.stringify({ accepted: true, echo: 'alpha-42' }),
        },
      ],
      max_tokens: 256,
    }
    const continuation = await calibrate({
      name: `single-tool-continuation-${mode.id}`,
      request: continuationRequest,
      client,
      counter,
    })
    results.push(continuation.result)

    const historyOnly = await calibrate({
      name: `history-only-final-${mode.id}`,
      request: {
        ...continuationRequest,
        tools: undefined,
        tool_choice: undefined,
      },
      client,
      counter,
    })
    results.push(historyOnly.result)

    const multiRequest = buildMultiToolRequest(model, mode)
    const multi = await calibrate({
      name: `multi-tool-reversed-results-${mode.id}`,
      request: multiRequest,
      client,
      counter,
    })
    results.push(multi.result)
  }

  const covered = results.filter((result) => result.status === 'covered')
  const exact = covered.every((result) => result.delta === 0)
  const output = {
    check: 'deepseek-v4-tool-tokenizer',
    ok: exact,
    provider: provider.id,
    model,
    requestCount: covered.length,
    exactCount: covered.filter((result) => result.delta === 0).length,
    notCoveredCount: results.length - covered.length,
    results,
  }
  console.log(JSON.stringify(output, null, 2))
  if (!exact) throw new Error('DeepSeek V4 tool tokenizer calibration did not match Provider prompt usage exactly.')
}

async function calibrate({ name, request, client, counter }) {
  let localTokens
  try {
    localTokens = counter.countRequest(request)
  } catch (error) {
    // The counter refuses shapes it has not verified; report them instead of
    // spending a Provider request on a count LS will not claim.
    return {
      result: {
        name,
        status: 'not_covered',
        reason: error instanceof Error ? error.message : String(error),
      },
    }
  }
  const startedAt = Date.now()
  const response = await client.chat(request)
  const providerPromptTokens = response.usage?.promptTokens
  if (!Number.isSafeInteger(providerPromptTokens) || providerPromptTokens <= 0) {
    throw new Error(`${name} did not return authoritative Provider prompt usage.`)
  }
  return {
    response,
    result: {
      name,
      status: 'covered',
      localTokens,
      providerPromptTokens,
      delta: providerPromptTokens - localTokens,
      cachedPromptTokens: response.usage?.cachedPromptTokens ?? 0,
      durationMs: Date.now() - startedAt,
      finishReason: response.finishReason,
      toolCallCount: response.toolCalls.length,
    },
  }
}

function buildMultiToolRequest(model, mode) {
  const callA = {
    id: 'calibration-call-a',
    type: 'function',
    function: {
      name: 'calibration_glob',
      arguments: JSON.stringify({ path: 'src/**/*.ts', limit: 7 }),
    },
  }
  const callB = {
    id: 'calibration-call-b',
    type: 'function',
    function: {
      name: 'calibration_search',
      arguments: JSON.stringify({
        query: 'LittleSheep',
        caseSensitive: false,
        paths: ['src', 'test'],
      }),
    },
  }
  return {
    model,
    messages: [
      {
        role: 'user',
        content: 'Run both calibration tools, then report whether both deterministic results succeeded.',
      },
      {
        role: 'assistant',
        content: '',
        reasoning_content: mode.thinking.type === 'enabled' ? 'I need both calibration results before answering.' : undefined,
        tool_calls: [callA, callB],
      },
      {
        role: 'tool',
        tool_call_id: callB.id,
        name: callB.function.name,
        content: JSON.stringify({ matches: ['src/index.ts', 'test/index.test.ts'] }),
      },
      {
        role: 'tool',
        tool_call_id: callA.id,
        name: callA.function.name,
        content: JSON.stringify({ paths: ['src/a.ts', 'src/b.ts'] }),
      },
    ],
    tools: MULTI_TOOLS,
    tool_choice: 'auto',
    max_tokens: 256,
    reasoning_effort: mode.reasoning_effort,
    thinking: mode.thinking,
  }
}

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    if (current === '--' || !current?.startsWith('--')) continue
    const equals = current.indexOf('=')
    if (equals > 2) {
      values.set(current.slice(2, equals), current.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      values.set(current.slice(2), next)
      index += 1
    }
  }
  const timeoutSeconds = Number(values.get('timeout-seconds') ?? 120)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 600) {
    throw new Error('timeout-seconds must be between 30 and 600.')
  }
  return {
    provider: values.get('provider'),
    model: values.get('model'),
    timeoutSeconds,
  }
}

async function loadEncryptedKeys(dataDir) {
  let store
  try {
    store = parseObject(await readFile(join(dataDir, 'config', 'keys.json'), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`Unable to read encrypted Provider keys: ${errorName(error)}`)
  }
  if (!store) return {}
  const keys = {}
  for (const [name, encoded] of Object.entries(store)) {
    if (typeof encoded !== 'string') continue
    const encrypted = Buffer.from(encoded, 'base64')
    let plaintext
    if (safeStorage.isEncryptionAvailable()) {
      try {
        plaintext = safeStorage.decryptString(encrypted)
      } catch {
        const fallback = encrypted.toString('utf8')
        if (isPlausibleSecret(fallback)) plaintext = fallback
      }
    } else {
      const fallback = encrypted.toString('utf8')
      if (isPlausibleSecret(fallback)) plaintext = fallback
    }
    const normalized = plaintext ? normalizeApiKey(plaintext) : ''
    if (normalized) keys[name] = normalized
  }
  return keys
}

function injectKeys(keys) {
  for (const [name, value] of Object.entries(keys)) {
    const normalized = normalizeApiKey(value)
    if (normalized) process.env[name] = normalized
  }
}

function configuredProviderId(modelRef) {
  const slash = modelRef.indexOf('/')
  return slash > 0 ? modelRef.slice(0, slash) : 'deepseek'
}

function configuredModel(modelRef, providerId) {
  const prefix = `${providerId}/`
  return modelRef.startsWith(prefix) ? modelRef.slice(prefix.length) : undefined
}

function resolveChromiumUserDataDir() {
  const explicit = process.env.LITTLESHEEP_CHROMIUM_USER_DATA_DIR
  if (explicit?.trim()) return resolve(explicit)
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), '@littlesheep', 'app')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', '@littlesheep', 'app')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), '@littlesheep', 'app')
}

function parseObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isPlausibleSecret(value) {
  const normalized = normalizeApiKey(value)
  return normalized.length >= 8
    && normalized.length <= 4_096
    && !/\s/u.test(normalized)
    && !normalized.includes('\uFFFD')
    && ![...normalized].some((character) => /[\u0000-\u001f\u007f]/u.test(character))
}

function normalizeApiKey(value) {
  let normalized = value.trim()
  if (
    normalized.length >= 2
    && ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim()
  }
  return normalized.replace(/^Bearer\s+/iu, '').trim()
}

function safeErrorDetails(error) {
  if (!(error instanceof Error)) return { errorKind: typeof error }
  const details = {
    errorKind: error.name || 'Error',
    errorMessage: redactErrorMessage(error.message),
  }
  if (typeof error.status === 'number') details.status = error.status
  if (typeof error.retryable === 'boolean') details.retryable = error.retryable
  return details
}

function redactErrorMessage(message) {
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/api key:\s*\S+/giu, 'api key: [redacted]')
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gu, '[redacted-key]')
    .replace(/\*{2,}[A-Za-z0-9]{2,}/gu, '[redacted-key]')
    .replace(/[A-Za-z0-9+/=_-]{48,}/gu, '[redacted-token]')
    .slice(0, 400)
}

function errorName(error) {
  return error instanceof Error ? error.name || 'Error' : typeof error
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(JSON.stringify({ check: 'deepseek-v4-tool-tokenizer', ok: false, ...safeErrorDetails(error) }))
    app.exit(1)
  })
