// Provider calibration owns bounded live-provider smoke checks exposed by Main.
// It reports protocol capability and usage without exposing credentials or payloads.
import type { AgentRunner } from '@littlesheep/runner'

type CalibrationClient = AgentRunner['infra']['llm']
type ChatRequest = Parameters<CalibrationClient['chat']>[0]
type ChatResponse = Awaited<ReturnType<CalibrationClient['chat']>>

export const PROVIDER_CALIBRATION_CHECKS = ['chat', 'continuity', 'tool', 'abort'] as const

export type ProviderCalibrationCheck = typeof PROVIDER_CALIBRATION_CHECKS[number]

export interface ProviderCalibrationRequestOptions {
  reasoning_effort?: ChatRequest['reasoning_effort']
  thinking?: ChatRequest['thinking']
  timeoutMs: number
}

export interface ProviderCalibrationResult {
  check: ProviderCalibrationCheck
  ok: boolean
  provider: string
  model: string
  durationMs: number
  [key: string]: unknown
}

export async function runProviderCalibration(input: {
  client: CalibrationClient
  provider: string
  model: string
  checks: readonly ProviderCalibrationCheck[]
  requestOptions: ProviderCalibrationRequestOptions
}): Promise<ProviderCalibrationResult[]> {
  const results: ProviderCalibrationResult[] = []
  for (const check of input.checks) {
    if (check === 'chat') results.push(await runChat(input))
    if (check === 'continuity') results.push(await runContinuity(input))
    if (check === 'tool') results.push(await runTool(input))
    if (check === 'abort') results.push(await runAbort(input))
  }
  return results
}

async function runChat(input: CalibrationInput): Promise<ProviderCalibrationResult> {
  const startedAt = Date.now()
  try {
    const response = await input.client.chat({
      model: input.model,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      max_tokens: 256,
      ...input.requestOptions,
    })
    const content = response.content.trim()
    const acknowledgedExactly = /^ok$/iu.test(content)
    return successResult('chat', input, startedAt, response, {
      contentCharacters: content.length,
      reasoningCharacters: response.reasoningContent?.length ?? 0,
      acknowledgedExactly,
    }, acknowledgedExactly)
  } catch (error) {
    return failedResult('chat', input, startedAt, error)
  }
}

async function runContinuity(input: CalibrationInput): Promise<ProviderCalibrationResult> {
  const startedAt = Date.now()
  try {
    const response = await input.client.chat({
      model: input.model,
      messages: [
        {
          role: 'system',
          content: [
            'Continue the supplied conversation unless the user changes topics.',
            'Resolve shorthand and numeric references from recent messages before asking for repeated information.',
            'A later explicit correction supersedes an earlier conflicting claim in the same topic.',
            'Answer the final user message concisely.',
          ].join(' '),
        },
        { role: 'user', content: 'Project Atlas has a confirmed budget of 750 credits.' },
        { role: 'assistant', content: 'Understood. Project Atlas currently has a budget of 750 credits.' },
        { role: 'user', content: 'Correction: its confirmed budget is 800 credits.' },
        { role: 'assistant', content: 'Updated. Project Atlas has a confirmed budget of 800 credits.' },
        { role: 'user', content: 'What is its confirmed budget now?' },
      ],
      max_tokens: 256,
      ...input.requestOptions,
    })
    const content = response.content.trim()
    const resolvedLatestValue = /\b800\b/u.test(content)
    const repeatedQuestion = /which project|what project|clarify|more context/iu.test(content)
    return successResult('continuity', input, startedAt, response, {
      resolvedLatestValue,
      askedForRepeatedSubject: repeatedQuestion,
      contentCharacters: content.length,
    }, content.length > 0 && resolvedLatestValue && !repeatedQuestion)
  } catch (error) {
    return failedResult('continuity', input, startedAt, error)
  }
}

async function runTool(input: CalibrationInput): Promise<ProviderCalibrationResult> {
  const startedAt = Date.now()
  const messages: ChatRequest['messages'] = [{
    role: 'user',
    content: 'Call provider_smoke_probe exactly once with value set to ok. Do not answer directly.',
  }]
  const tools: NonNullable<ChatRequest['tools']> = [{
    type: 'function',
    function: {
      name: 'provider_smoke_probe',
      description: 'Returns the supplied smoke-test value.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', enum: ['ok'] } },
        required: ['value'],
        additionalProperties: false,
      },
    },
  }]

  try {
    const first = await input.client.chat({
      model: input.model,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 512,
      ...input.requestOptions,
    })
    const calls = first.toolCalls.filter((call) => call.function.name === 'provider_smoke_probe')
    if (calls.length !== 1) {
      return baseResult('tool', input, startedAt, false, {
        finishReason: first.finishReason,
        reason: `Expected one provider_smoke_probe call, received ${calls.length}.`,
        toolNames: first.toolCalls.map((call) => call.function.name),
        usage: sanitizeUsage(first.usage),
      })
    }
    const probeArguments = parseProbeArguments(calls[0]!.function.arguments)
    if (probeArguments?.value !== 'ok') {
      return baseResult('tool', input, startedAt, false, {
        finishReason: first.finishReason,
        reason: 'provider_smoke_probe arguments did not contain value="ok".',
        argumentsValid: false,
        usage: sanitizeUsage(first.usage),
      })
    }

    const second = await input.client.chat({
      model: input.model,
      messages: [
        ...messages,
        {
          role: 'assistant',
          content: first.content,
          reasoning_content: first.reasoningContent,
          tool_calls: first.toolCalls,
        },
        {
          role: 'tool',
          tool_call_id: calls[0]!.id,
          name: calls[0]!.function.name,
          content: JSON.stringify({ value: 'ok' }),
        },
      ],
      tools,
      tool_choice: 'auto',
      max_tokens: 256,
      ...input.requestOptions,
    })
    const continuationToolNames = second.toolCalls.map((call) => call.function.name)
    const completedAfterTool = second.content.trim().length > 0
      && second.finishReason !== 'tool_calls'
      && continuationToolNames.length === 0
    return baseResult('tool', input, startedAt, completedAfterTool, {
      firstFinishReason: first.finishReason,
      continuationFinishReason: second.finishReason,
      toolNames: first.toolCalls.map((call) => call.function.name),
      argumentsValid: true,
      continuationToolNames,
      reasoningReplayed: Boolean(first.reasoningContent),
      contentCharacters: second.content.length,
      usage: {
        first: sanitizeUsage(first.usage),
        continuation: sanitizeUsage(second.usage),
      },
    })
  } catch (error) {
    return failedResult('tool', input, startedAt, error)
  }
}

function parseProbeArguments(value: string): { value?: unknown } | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as { value?: unknown }
      : undefined
  } catch {
    return undefined
  }
}

async function runAbort(input: CalibrationInput): Promise<ProviderCalibrationResult> {
  const startedAt = Date.now()
  const controller = new AbortController()
  let receivedChunk = false
  const fallback = setTimeout(() => controller.abort(), Math.min(1_500, input.requestOptions.timeoutMs))
  try {
    await input.client.chatStream({
      model: input.model,
      messages: [{
        role: 'user',
        content: 'Produce a detailed numbered analysis of twelve independent considerations.',
      }],
      max_tokens: 2_048,
      stream: true,
      ...input.requestOptions,
      signal: controller.signal,
    }, () => {
      receivedChunk = true
      controller.abort()
    })
    return baseResult('abort', input, startedAt, false, {
      receivedChunk,
      reason: 'Request completed before cancellation took effect.',
    })
  } catch (error) {
    return baseResult('abort', input, startedAt, controller.signal.aborted, {
      receivedChunk,
      outcome: controller.signal.aborted ? 'aborted' : 'failed_before_abort',
      errorKind: errorName(error),
    })
  } finally {
    clearTimeout(fallback)
  }
}

type CalibrationInput = Parameters<typeof runProviderCalibration>[0]

function successResult(
  check: ProviderCalibrationCheck,
  input: CalibrationInput,
  startedAt: number,
  response: ChatResponse,
  details: Record<string, unknown>,
  ok = true,
): ProviderCalibrationResult {
  return baseResult(check, input, startedAt, ok, {
    finishReason: response.finishReason,
    usage: sanitizeUsage(response.usage),
    ...details,
  })
}

function failedResult(
  check: ProviderCalibrationCheck,
  input: CalibrationInput,
  startedAt: number,
  error: unknown,
): ProviderCalibrationResult {
  return baseResult(check, input, startedAt, false, safeErrorDetails(error))
}

function baseResult(
  check: ProviderCalibrationCheck,
  input: CalibrationInput,
  startedAt: number,
  ok: boolean,
  details: Record<string, unknown>,
): ProviderCalibrationResult {
  return {
    check,
    ok,
    provider: input.provider,
    model: input.model,
    ...details,
    durationMs: Date.now() - startedAt,
  }
}

function sanitizeUsage(usage: ChatResponse['usage']): Record<string, number> | undefined {
  if (!usage) return undefined
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cachedPromptTokens === undefined ? {} : { cachedPromptTokens: usage.cachedPromptTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
}

function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorKind: typeof error }
  const details: Record<string, unknown> = {
    errorKind: error.name || 'Error',
    errorMessage: redactErrorMessage(error.message),
  }
  if ('status' in error && typeof error.status === 'number') details.status = error.status
  if ('retryable' in error && typeof error.retryable === 'boolean') details.retryable = error.retryable
  return details
}

function redactErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/api key:\s*\S+/giu, 'api key: [redacted]')
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/gu, '[redacted-key]')
    .replace(/\*{2,}[A-Za-z0-9]{2,}/gu, '[redacted-key]')
    .replace(/[A-Za-z0-9+/=_-]{48,}/gu, '[redacted-token]')
    .slice(0, 300)
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name || 'Error' : typeof error
}
