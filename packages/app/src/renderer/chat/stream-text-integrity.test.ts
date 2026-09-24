// UX-20 layer probe: where does streamed text survive, and where is it retracted?
//
// The user report is "some characters change colour and some text looks swallowed". This file
// drives the *real* renderer layers with one deterministic markdown sample and asserts what
// each boundary does to the text, so a later fix targets the layer that actually loses it
// instead of guessing. The layers, in order:
//
//   Local App API SSE frames            -> consumeRunStream (real)
//   delta/replace handlers              -> createAssistantDeltaBuffer (real) + the same
//                                          `text + delta` / `() => text` updates run-actions uses
//   run settlement                      -> reduceCompletedRunMessages (real)
//
// Covered failure modes: normal stream, a frame split across reads, a malformed frame, a
// transport retry (the server sends `replace ''`), an abrupt stream end, and a non-success run.
import { describe, expect, it, vi } from 'vitest'
import { consumeRunStream, type RunResult, type RunStreamHandlers } from '../api/run'
import { createAssistantDeltaBuffer } from './assistant-delta-buffer'
import { reduceCompletedRunMessages } from './run-result-reducer'
import type { ChatMessage } from './types'

/** Markdown-ish sample: heading, list, link, quote, fence, Chinese punctuation, long paragraph. */
const SAMPLE = [
  '## 结论',
  '',
  '缓存命中率已达标：`99.13%`，详见 [验收规程](https://example.test/a)。',
  '',
  '- 第一项：中文标点（，。；：「」）不应丢失',
  '- 第二项：反引号 `code` 与**加粗**混排',
  '',
  '> 引用段落用于检查行首符号。',
  '',
  '```ts',
  'const answer = 42 // 代码围栏内不应触发工具解析',
  '```',
  '',
  '最后一段是较长的中文正文，用来确认流式尾部反复解析后仍然完整；这里刻意放上省略号……以及括号（含中文括号）与数字 1,234.56，避免只验证英文。',
].join('\n')

function runStreamResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function frames(events: Array<{ name: string; data: unknown }>): string[] {
  return events.map((event) => `event: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`)
}

function result(overrides: Partial<RunResult>): RunResult {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'ok',
    reply: SAMPLE,
    durationMs: 12,
    ...overrides,
  } as RunResult
}

function assistantTurn(text: string): ChatMessage[] {
  return [{ id: 'm1', role: 'user', text: '开始', timestamp: new Date(0).toISOString() }, {
    id: 'm2',
    role: 'assistant',
    text,
    timestamp: new Date(0).toISOString(),
  }] as ChatMessage[]
}

/** Drive the real consumer + buffer exactly like run-actions does, and return the visible text. */
async function visibleTextFromStream(chunks: string[]): Promise<{ text: string; deltas: string[]; replacements: string[] }> {
  let messages = assistantTurn('')
  const deltas: string[] = []
  const replacements: string[] = []
  const updateText = (update: (text: string) => string) => {
    const last = messages[messages.length - 1]!
    messages = [...messages.slice(0, -1), { ...last, text: update(last.text) }]
  }
  const buffer = createAssistantDeltaBuffer((delta) => updateText((text) => text + delta))
  const handlers: RunStreamHandlers = {
    onDelta: (delta) => { deltas.push(delta); buffer.push(delta) },
    onReplace: (text) => { replacements.push(text); buffer.clear(); updateText(() => text) },
  }
  await consumeRunStream(runStreamResponse(chunks), handlers)
  buffer.flush()
  return { text: messages[messages.length - 1]!.text, deltas, replacements }
}

describe('UX-20 streamed text integrity', () => {
  it('keeps the sample byte-identical through SSE, buffering and settlement', async () => {
    const events = frames([
      { name: 'start', data: { ok: true, runId: 'run-1' } },
      ...SAMPLE.split(/(?<=\n)/u).map((line) => ({ name: 'delta', data: { delta: line } })),
      { name: 'result', data: result({}) },
    ])
    const { text, deltas, replacements } = await visibleTextFromStream(events)

    expect(text).toBe(SAMPLE)
    expect(deltas.join('')).toBe(SAMPLE)
    expect(replacements).toEqual([])

    const settled = reduceCompletedRunMessages(assistantTurn(text), result({}))
    expect(settled[settled.length - 1]!.text).toBe(SAMPLE)
  })

  it('reassembles a frame that arrives split across reads', async () => {
    const whole = frames([
      { name: 'start', data: { ok: true, runId: 'run-1' } },
      { name: 'delta', data: { delta: '前半段' } },
      { name: 'delta', data: { delta: '后半段' } },
      { name: 'result', data: result({ reply: '前半段后半段' }) },
    ]).join('')
    const cut = Math.floor(whole.length / 3)
    const { text, deltas } = await visibleTextFromStream([whole.slice(0, cut), whole.slice(cut, cut * 2), whole.slice(cut * 2)])
    expect(deltas.join('')).toBe('前半段后半段')
    expect(text).toBe('前半段后半段')
  })

  it('skips a malformed frame without dropping its neighbours', async () => {
    const events = [
      ...frames([{ name: 'start', data: { ok: true, runId: 'run-1' } }]),
      'event: delta\ndata: {"delta": "坏帧前面}\n\n',
      ...frames([
        { name: 'delta', data: { delta: '保留的正文' } },
        { name: 'result', data: result({ reply: '保留的正文' }) },
      ]),
    ]
    const { text, deltas } = await visibleTextFromStream(events)
    expect(deltas.join('')).toBe('保留的正文')
    expect(text).toBe('保留的正文')
  })

  it('still fails closed when the frame that never parses is the result', async () => {
    // Skipping a corrupt frame must not turn "no verdict" into "silent success".
    const events = [
      ...frames([{ name: 'start', data: { ok: true, runId: 'run-1' } }]),
      { name: 'delta', data: { delta: '正文' } },
      'event: result\ndata: {"status": "ok", broken}\n\n',
    ].map((entry) => (typeof entry === 'string' ? entry : frames([entry])[0]!))
    await expect(visibleTextFromStream(events)).rejects.toThrow('ended without result')
  })

  it('documents what a transport retry does to already-visible text', async () => {
    // reply.ts answers a client `reset` with `ctx.onAssistantReplace('')`, which the server
    // forwards as `replace ''`. The preview is therefore cleared before the retry streams the
    // answer again: no duplication, but the reader sees the text disappear and restart.
    const events = [
      ...frames([
        { name: 'start', data: { ok: true, runId: 'run-1' } },
        { name: 'delta', data: { delta: '第一次尝试的前半段' } },
      ]),
      ...frames([
        { name: 'replace', data: { text: '' } },
        { name: 'delta', data: { delta: SAMPLE } },
        { name: 'result', data: result({}) },
      ]),
    ]
    const { text, replacements } = await visibleTextFromStream(events)

    expect(replacements).toEqual([''])
    expect(text).toBe(SAMPLE)
    expect(text).not.toContain('第一次尝试')
  })

  it('keeps whatever was streamed when the stream ends without a result frame', async () => {
    const events = frames([
      { name: 'start', data: { ok: true, runId: 'run-1' } },
      { name: 'delta', data: { delta: '断流前已经显示的文字' } },
    ])
    // No verdict arrives, so the consumer rejects (fail closed) rather than inventing a
    // result; the already-rendered preview stays on screen because nothing retracted it.
    await expect(visibleTextFromStream(events)).rejects.toThrow('ended without result')
  })

  it('retracts the preview when the run settles as aborted or failed', async () => {
    const preview = assistantTurn(SAMPLE)
    for (const status of ['aborted', 'error'] as const) {
      const settled = reduceCompletedRunMessages(preview, result({ status, reply: '', finalReplySettlement: undefined }))
      expect(settled[settled.length - 1]!.text, `${status} must not keep an unverified preview`).toBe('')
    }
    // A settled reply replaces the preview verbatim.
    const replaced = reduceCompletedRunMessages(preview, result({
      reply: '权威结算正文',
      finalReplySettlement: { status: 'settled', reply: '权威结算正文' },
    } as Partial<RunResult>))
    expect(replaced[replaced.length - 1]!.text).toBe('权威结算正文')
  })

  it('prefers the settlement text over the streamed preview when they differ', () => {
    const preview = assistantTurn('预览版文字')
    const settled = reduceCompletedRunMessages(preview, result({
      reply: '结算版文字',
      finalReplySettlement: { status: 'settled', reply: '结算版文字' },
    } as Partial<RunResult>))
    expect(settled[settled.length - 1]!.text).toBe('结算版文字')
  })
})

describe('UX-20 buffer edge cases', () => {
  it('drops pending text only when the preview is replaced', () => {
    const flushed: string[] = []
    const scheduled: Array<() => void> = []
    const buffer = createAssistantDeltaBuffer((delta) => flushed.push(delta), (callback) => {
      scheduled.push(callback)
      return vi.fn()
    })
    buffer.push('会被清掉的尾部')
    buffer.clear()
    scheduled.forEach((callback) => callback())
    expect(flushed).toEqual([])

    buffer.push('保留')
    buffer.flush()
    expect(flushed).toEqual(['保留'])
  })
})
