import { describe, expect, it } from 'vitest'
import { textMessage, type RunAttachment } from '@littlesheep/types'
import { createMockLlm, makeCtx, textResponse } from '../tests/helpers.js'
import {
  SHARED_HISTORY_BOUNDARY_QUANTUM,
  SHARED_HISTORY_MAX_CHARS,
  attachmentContextMessages,
  attachmentManifestText,
  callLlmForJson,
  conversationHistoryForModel,
  extractJson,
  recentHistoryForModel,
  textOf,
} from './_shared.js'
import { modelRequestIdFor, prepareModelRequest } from '../model-observability.js'

describe('attachment context helpers', () => {
  const attachment: RunAttachment = {
    id: 'attachment-1',
    path: 'D:/files/notes.md',
    name: 'notes.md',
    kind: 'document',
    size: 128,
    ownership: 'external',
    contentState: 'uninspected',
  }

  it('publishes a manifest id and an explicit on-demand inspection path', () => {
    const manifest = attachmentManifestText([attachment])
    expect(manifest).toContain('[attachment-1] notes.md')
    expect(manifest).toContain('uninspected')
    expect(manifest).toContain('inspect_attachment')
  })

  it('publishes source line comments with their exact path and range', () => {
    const manifest = attachmentManifestText([{
      ...attachment,
      path: 'D:/managed-cache/app.ts',
      contextPath: 'src/app.ts',
      name: 'app.ts',
      lineComments: [{
        startLine: 42,
        endLine: 45,
        text: 'Keep this update inside the transaction.',
      }],
    }])

    expect(manifest).toContain('path=src/app.ts')
    expect(manifest).not.toContain('path=D:/managed-cache/app.ts')
    expect(manifest).toContain('lines 42-45: Keep this update inside the transaction.')
  })

  it('does not inject extracted text outside the tool result path', () => {
    const messages = attachmentContextMessages('run-attachments', [{
      ...attachment,
      extractedText: 'private file body',
      contentState: 'loaded',
    }])
    expect(messages).toHaveLength(1)
    expect(String(messages[0]?.message.content)).not.toContain('private file body')
    expect(messages[0]?.context).toMatchObject({
      id: 'attachment-manifest:run-attachments',
      source: {
        kind: 'attachment',
        id: 'attachment-manifest:run-attachments',
        runId: 'run-attachments',
      },
    })
  })
})

describe('callLlmForJson retry budgets', () => {
  it('expands the output budget and exposes an empty-response retry', async () => {
    const requests: Array<{ maxTokens?: number; previousResponseWasEmpty: boolean }> = []
    const llm = createMockLlm([
      textResponse(''),
      textResponse('{"ok":true}'),
    ])

    const result = await callLlmForJson<{ ok: boolean }>(llm, 'test', [
      { role: 'system', content: 'Reply with a JSON object.' },
      { role: 'user', content: 'return json' },
    ], {
      maxAttempts: 3,
      maxTokens: 100,
      maxTokensCeiling: 400,
      onRequest: (request, retry) => {
        requests.push({
          maxTokens: request.max_tokens,
          previousResponseWasEmpty: retry.previousResponseWasEmpty,
        })
      },
    })

    expect(result).toMatchObject({ parsed: { ok: true }, attempts: 2 })
    expect(requests).toEqual([
      { maxTokens: 100, previousResponseWasEmpty: false },
      { maxTokens: 200, previousResponseWasEmpty: true },
    ])
  })

  it('expands the retry budget for non-empty malformed JSON', async () => {
    const maxTokens: Array<number | undefined> = []
    const llm = createMockLlm([
      textResponse('not json'),
      textResponse('still not json'),
    ])

    const result = await callLlmForJson(llm, 'test', [
      { role: 'user', content: 'return json' },
    ], {
      maxAttempts: 2,
      maxTokens: 100,
      maxTokensCeiling: 400,
      onRequest: (request) => {
        maxTokens.push(request.max_tokens)
      },
    })

    expect(result.parsed).toBeNull()
    expect(maxTokens).toEqual([100, 150])
  })

  it('passes the prepared parent request identity to a parse retry', async () => {
    const requests: Array<{ id?: string; previousRequestId?: string; reason?: string }> = []
    const ctx = makeCtx()
    const llm = createMockLlm([
      textResponse('not json'),
      textResponse('{"ok":true}'),
    ])

    const result = await callLlmForJson<{ ok: boolean }>(llm, 'test', [
      { role: 'system', content: 'Reply with a JSON object.' },
      { role: 'user', content: 'return json' },
    ], {
      maxAttempts: 2,
      onRequest: (request, retry) => {
        const prepared = prepareModelRequest(ctx, 'reply', request, undefined, {
          retryOf: retry.previousRequestId,
          retryReason: retry.previousFailureReason,
        })
        requests.push({
          id: modelRequestIdFor(prepared),
          previousRequestId: retry.previousRequestId,
          reason: retry.previousFailureReason,
        })
        return prepared
      },
    })

    expect(result.parsed).toEqual({ ok: true })
    expect(requests[0]?.previousRequestId).toBeUndefined()
    expect(requests[1]?.previousRequestId).toBe(requests[0]?.id)
    expect(requests[1]?.reason).toBe('decode')
    expect(ctx.modelRequests?.map((request) => request.retryOf)).toEqual([undefined, requests[0]?.id])
    expect(ctx.modelRequests?.map((request) => request.retryReason)).toEqual([undefined, 'decode'])
  })

  it('classifies length and schema retries without adding a third JSON attempt', async () => {
    const lengthReasons: Array<string | undefined> = []
    const lengthResult = await callLlmForJson<{ ok: boolean }>(createMockLlm([
      textResponse('{"ok":', 'length'),
      textResponse('{"ok":true}'),
    ]), 'test', [{ role: 'user', content: 'return json' }], {
      maxAttempts: 2,
      onRequest: (_request, retry) => { lengthReasons.push(retry.previousFailureReason) },
    })
    expect(lengthResult).toMatchObject({ parsed: { ok: true }, attempts: 2 })
    expect(lengthReasons).toEqual([undefined, 'length'])

    const schemaReasons: Array<string | undefined> = []
    const schemaResult = await callLlmForJson<{ ok: boolean }>(createMockLlm([
      textResponse('{"ok":"wrong"}'),
      textResponse('{"ok":true}'),
    ]), 'test', [{ role: 'user', content: 'return json' }], {
      maxAttempts: 2,
      validateParsed: (value) => {
        if (!value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) {
          throw new Error('schema')
        }
        return value as { ok: boolean }
      },
      onRequest: (_request, retry) => { schemaReasons.push(retry.previousFailureReason) },
    })
    expect(schemaResult).toMatchObject({ parsed: { ok: true }, attempts: 2 })
    expect(schemaReasons).toEqual([undefined, 'schema'])
  })
})

describe('extractJson', () => {
  it('handles nested braces and escaped quotes inside JSON strings', () => {
    expect(extractJson('result: {"input":{"pattern":"{*.ts,*.tsx}"},"note":"say \\"ok\\""}')).toEqual({
      input: { pattern: '{*.ts,*.tsx}' },
      note: 'say "ok"',
    })
  })

  it('uses the final complete JSON object when prose contains an earlier example', () => {
    expect(extractJson([
      'Example: {"tool":"toolName","input":{}}',
      'Final:',
      '```json',
      '{"tool":"glob","input":{"pattern":"*"}}',
      '```',
    ].join('\n'))).toEqual({ tool: 'glob', input: { pattern: '*' } })
  })
})

describe('recentHistoryForModel', () => {
  it('keeps only the bounded recent window without changing durable history', () => {
    const history = Array.from({ length: 20 }, (_, index) => textMessage(
      index % 2 === 0 ? 'user' : 'assistant',
      `message-${index}`,
    ))

    const selected = recentHistoryForModel(history, 8)

    expect(selected).toHaveLength(8)
    expect(selected[0]?.content[0]).toMatchObject({ type: 'text', text: 'message-12' })
    expect(history).toHaveLength(20)
  })

  it('also bounds recent history by characters without changing durable history', () => {
    const old = textMessage('user', 'x'.repeat(5_000))
    const recent = textMessage('assistant', 'y'.repeat(500))

    const selected = recentHistoryForModel([old, recent], 8, 1_000)

    expect(selected).toHaveLength(1)
    expect(textOf(selected[0]!)).toBe('y'.repeat(500))
    expect(textOf(old)).toHaveLength(5_000)
  })
})

/** The prefix-diff invariant the live measurement showed we were missing. */
describe('conversationHistoryForModel prefix diff', () => {
  const historyOf = (count: number, size = 40) => Array.from({ length: count }, (_, index) => textMessage(
    index % 2 === 0 ? 'user' : 'assistant',
    `turn-${index}-${'x'.repeat(size)}`,
  ))
  const texts = (count: number, size = 40) => conversationHistoryForModel({ history: historyOf(count, size) })
    .map((message) => textOf(message))

  it('extends the previous request instead of rebuilding it while the budget holds', () => {
    for (let count = 2; count <= 40; count += 1) {
      const previous = texts(count - 1)
      const current = texts(count)
      expect(current.slice(0, previous.length)).toEqual(previous)
    }
  })

  it('moves the window boundary a quantum at a time once the budget is exceeded', () => {
    // ~1_000 characters per message: the transcript crosses the budget quickly.
    const size = 1_000
    const turns = 200
    const full = historyOf(turns, size)
    let previousStart = 0
    let boundaryMoves = 0
    let appendOnlyTurns = 0

    for (let count = 2; count <= turns; count += 1) {
      const history = full.slice(0, count)
      const projected = conversationHistoryForModel({ history })
      expect(projected.length).toBeGreaterThan(0)
      const start = history.indexOf(projected[0]!)
      expect(start % SHARED_HISTORY_BOUNDARY_QUANTUM).toBe(0)
      expect(projected.length * size)
        .toBeLessThanOrEqual(SHARED_HISTORY_MAX_CHARS + SHARED_HISTORY_BOUNDARY_QUANTUM * size)
      if (start === previousStart) {
        appendOnlyTurns += 1
      } else {
        boundaryMoves += 1
        previousStart = start
      }
    }

    // One boundary move per quantum at most, never one per turn.
    expect(boundaryMoves).toBeLessThanOrEqual(Math.ceil(turns / SHARED_HISTORY_BOUNDARY_QUANTUM))
    expect(appendOnlyTurns).toEqual(turns - 1 - boundaryMoves)
  })
})
