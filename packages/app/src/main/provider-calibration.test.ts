import { describe, expect, it, vi } from 'vitest'
import type { AgentRunner } from '@littlesheep/runner'
import { runProviderCalibration } from './provider-calibration.js'

type CalibrationClient = AgentRunner['infra']['llm']

describe('Provider calibration', () => {
  it('calibrates chat, continuity, tool continuation, and cancellation', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce(response('OK'))
      .mockResolvedValueOnce(response('Project Atlas has 800 confirmed credits.'))
      .mockResolvedValueOnce({
        ...response(''),
        finishReason: 'tool_calls',
        reasoningContent: 'tool reasoning',
        toolCalls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'provider_smoke_probe', arguments: '{"value":"ok"}' },
        }],
      })
      .mockResolvedValueOnce(response('The probe completed successfully.'))
    const chatStream = vi.fn(async (_request, onDelta) => {
      onDelta({ type: 'delta', delta: 'partial' })
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    const client = {
      chat,
      chatStream,
      embed: vi.fn(),
    } as unknown as CalibrationClient

    const results = await runProviderCalibration({
      client,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      checks: ['chat', 'continuity', 'tool', 'abort'],
      requestOptions: { timeoutMs: 5_000 },
    })

    expect(results).toHaveLength(4)
    expect(results.every((result) => result.ok)).toBe(true)
    expect(results.find((result) => result.check === 'continuity')).toMatchObject({
      resolvedLatestValue: true,
      askedForRepeatedSubject: false,
    })
    expect(results.find((result) => result.check === 'tool')).toMatchObject({
      toolNames: ['provider_smoke_probe'],
      reasoningReplayed: true,
    })
    expect(results.find((result) => result.check === 'abort')).toMatchObject({
      receivedChunk: true,
      outcome: 'aborted',
    })
    expect(chat).toHaveBeenCalledTimes(4)
    expect(chatStream).toHaveBeenCalledTimes(1)
  })

  it('redacts credential-shaped content from Provider errors', async () => {
    const client = {
      chat: vi.fn(async () => {
        throw new Error('Bearer secret-token-value and api key: sk-abcdefghijk')
      }),
      chatStream: vi.fn(),
      embed: vi.fn(),
    } as unknown as CalibrationClient

    const [result] = await runProviderCalibration({
      client,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      checks: ['chat'],
      requestOptions: { timeoutMs: 5_000 },
    })

    expect(result).toMatchObject({ check: 'chat', ok: false, errorKind: 'Error' })
    expect(result?.errorMessage).not.toContain('secret-token-value')
    expect(result?.errorMessage).not.toContain('sk-abcdefghijk')
  })

  it('rejects a tool call whose arguments violate the calibration contract', async () => {
    const chat = vi.fn(async () => ({
      ...response(''),
      finishReason: 'tool_calls' as const,
      toolCalls: [{
        id: 'call-wrong',
        type: 'function' as const,
        function: { name: 'provider_smoke_probe', arguments: '{"value":"wrong"}' },
      }],
    }))
    const client = { chat, chatStream: vi.fn(), embed: vi.fn() } as unknown as CalibrationClient

    const [result] = await runProviderCalibration({
      client,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      checks: ['tool'],
      requestOptions: { timeoutMs: 5_000 },
    })

    expect(result).toMatchObject({ check: 'tool', ok: false, argumentsValid: false })
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('rejects a tool continuation that requests another tool call', async () => {
    const first = {
      ...response(''),
      finishReason: 'tool_calls' as const,
      toolCalls: [{
        id: 'call-1',
        type: 'function' as const,
        function: { name: 'provider_smoke_probe', arguments: '{"value":"ok"}' },
      }],
    }
    const second = {
      ...response('trying again'),
      finishReason: 'tool_calls' as const,
      toolCalls: [{
        id: 'call-2',
        type: 'function' as const,
        function: { name: 'provider_smoke_probe', arguments: '{"value":"ok"}' },
      }],
    }
    const chat = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const client = { chat, chatStream: vi.fn(), embed: vi.fn() } as unknown as CalibrationClient

    const [result] = await runProviderCalibration({
      client,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      checks: ['tool'],
      requestOptions: { timeoutMs: 5_000 },
    })

    expect(result).toMatchObject({
      check: 'tool',
      ok: false,
      continuationToolNames: ['provider_smoke_probe'],
    })
    expect(chat).toHaveBeenCalledTimes(2)
  })
})

function response(content: string) {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop' as const,
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
  }
}
