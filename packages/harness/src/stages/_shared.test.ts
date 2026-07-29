import { describe, expect, it } from 'vitest'
import { textMessage, type RunAttachment } from '@littlesheep/types'
import { createMockLlm, textResponse } from '../tests/helpers.js'
import {
  attachmentContextMessages,
  attachmentManifestText,
  callLlmForJson,
  recentHistoryForModel,
  textOf,
} from './_shared.js'

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

  it('does not inflate the budget for non-empty malformed JSON', async () => {
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
    expect(maxTokens).toEqual([100, 100])
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
