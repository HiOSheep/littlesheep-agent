// CE-13: a brief the model never received must not be remembered as delivered.
//
// The environment brief is appended to the append-only tail and persisted with
// it, which is what lets a later run read the last observed state from the
// replay instead of keeping a change log. That mechanism has one dangerous
// failure mode: if a run records the brief but the Provider never received the
// request, the next run would read it from the transcript and stay silent about
// an environment the model has never been told about.
//
// The transcript is the only record the next run reads, and a failed run never
// appends its produced messages to it — so the fact is re-delivered. This pins
// that: the first run's request fails at the transport, nothing about the brief
// reaches the session, and the next run in the same session carries it again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatRequest, ChatResponse, LlmClient, StreamChunk } from '@littlesheep/llm'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { DEFAULT_BRANDING } from '@littlesheep/branding'
import { RUNTIME_CONTEXT_TAIL_ID } from '@littlesheep/harness'
import { createRunner } from './runner.js'

const createdRunners: Array<{ shutdown: () => Promise<void> }> = []
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ls-context-delivery-'))
  process.env.LITTLESHEEP_DATA_DIR = dataDir
  createdRunners.length = 0
})

afterEach(async () => {
  for (const runner of createdRunners) {
    try { await runner.shutdown() } catch { /* best-effort */ }
  }
  delete process.env.LITTLESHEEP_DATA_DIR
  rmSync(dataDir, { recursive: true, force: true })
})

function briefText(request: ChatRequest): string | undefined {
  return request.messages
    .map((message) => String(message.content ?? ''))
    .find((content) => content.includes('[Runtime context; effective for this request]'))
}

describe('the environment brief across a failed request', () => {
  it('re-delivers the brief after a run whose request never reached the Provider', async () => {
    const requests: ChatRequest[] = []
    let failNext = true
    const chat = vi.fn(async (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request)
      if (failNext) throw new Error('transport down')
      return { content: '好的。', toolCalls: [], finishReason: 'stop' }
    })
    const llm: LlmClient = {
      chat,
      chatStream: vi.fn(async (request: ChatRequest, onDelta: (chunk: StreamChunk) => void) => {
        const response = await chat(request)
        onDelta({ type: 'done', finishReason: response.finishReason })
        return response
      }),
      embed: vi.fn(async () => ({ embeddings: [], model: '', usage: { promptTokens: 0 } })),
    }
    const runner = await createRunner({
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'openai/gpt-test',
      llm,
      bootstrapDir: dataDir,
      skillsDirs: [],
    })
    createdRunners.push(runner)

    const first = await runner.run({ text: '开始吧' })
    expect(first.status).not.toBe('ok')
    // The brief was rendered into the failed run's own request...
    expect(briefText(requests[0]!)).toBeDefined()
    // ...but a failed run does not write its produced messages, so the next run
    // has no record of it having been delivered.
    const transcript = await runner.sessionManager.read(first.sessionId)
    expect(transcript.filter((message) => message.runtimeTailId === RUNTIME_CONTEXT_TAIL_ID)).toHaveLength(0)

    failNext = false
    const second = await runner.run({ sessionId: first.sessionId, text: '继续吧' })

    expect(second.status).toBe('ok')
    expect(briefText(requests.at(-1)!)).toBeDefined()
  })
})
