import { describe, expect, it } from 'vitest'
import { textMessage, type ChatMessage, type RunContext } from '@littlesheep/types'
import { makeCtx } from '../../tests/helpers.js'
import {
  persistVerifyGapControl,
  RUNTIME_CONTROL_MESSAGES,
  toolResultForModel,
} from './tool-result-persistence.js'

describe('tool result projection for the model', () => {
  it('sends only what the next turn can act on', () => {
    const projected = JSON.parse(toolResultForModel({
      callId: 'c1',
      ok: true,
      output: 'alpha.txt',
      durationMs: 42,
    })) as Record<string, unknown>

    // `status` and `durationMs` were framing only: 20% of all tool-result
    // characters across the frozen runs were wrapper text the model never used.
    expect(projected).toEqual({ ok: true, output: 'alpha.txt' })
  })

  it('keeps a successful call output and omits the error field', () => {
    const projected = JSON.parse(toolResultForModel({
      callId: 'c1',
      ok: true,
      output: 'alpha.txt',
    })) as Record<string, unknown>

    expect(projected).toMatchObject({ ok: true, output: 'alpha.txt' })
    expect(projected.error).toBeUndefined()
  })

  it('keeps the captured output of a failed call so the model can diagnose it', () => {
    const projected = JSON.parse(toolResultForModel({
      callId: 'c1',
      ok: false,
      error: 'exit code 1',
      output: 'not ok 1 - releases the reservation\n  expected: 2\n  actual: 0',
    })) as Record<string, unknown>

    // The exit code alone says nothing about what failed; the runner output is the
    // evidence the model needs, and the runtime already recorded it.
    expect(projected).toEqual({
      ok: false,
      output: 'not ok 1 - releases the reservation\n  expected: 2\n  actual: 0',
      error: 'exit code 1',
    })
  })

  it('prefers the tool-declared model output and keeps the sanitized marker', () => {
    const projected = JSON.parse(toolResultForModel({
      callId: 'c1',
      ok: true,
      output: 'raw output',
      modelOutput: 'bounded output',
      sanitized: true,
    })) as Record<string, unknown>

    expect(projected).toEqual({ ok: true, output: 'bounded output', sanitized: true })
  })

  it('omits an empty output instead of sending an empty string', () => {
    const projected = JSON.parse(toolResultForModel({ callId: 'c1', ok: false, error: 'denied' })) as Record<string, unknown>
    expect(projected).toEqual({ ok: false, error: 'denied' })
  })

  it('keeps the step id when the call belongs to one', () => {
    const projected = JSON.parse(toolResultForModel({
      callId: 'c1',
      ok: true,
      output: 'done',
      meta: { stepId: 'step-2' },
    })) as Record<string, unknown>
    expect(projected).toEqual({ ok: true, output: 'done', stepId: 'step-2' })
  })
})

describe('telling the model why the loop was re-entered', () => {
  function structuredGapContext(): RunContext {
    const ctx = makeCtx({ inbound: textMessage('user', '做一个小游戏吧') })
    ctx.lastError = { stage: 'verify', message: 'Recorded step evidence is incomplete: tool invocation call-1 is validation_failed' }
    ctx.verificationHistory = [{
      verdict: 'fail',
      reason: 'tool invocation call-1 is validation_failed',
      feedback: 'Recorded step evidence is incomplete: tool invocation call-1 is validation_failed',
      source: 'structural',
      attempt: 1,
      verifiedAt: '2026-09-23T18:54:26.986Z',
    }]
    return ctx
  }

  it('persists the gap as a Runtime control message the re-entered loop can read', () => {
    const ctx = structuredGapContext()
    const messages: ChatMessage[] = []

    persistVerifyGapControl(ctx, ctx.produced, messages)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'system', content: RUNTIME_CONTROL_MESSAGES.verifyGap })
    // Persisted, not only live: the request the next round sends must carry it too.
    expect(ctx.produced.some((message) => message.runtimeTail === true)).toBe(true)
  })

  it('says nothing when the loop was not re-entered for a gap', () => {
    const ordinary = makeCtx({ inbound: textMessage('user', 'go') })
    const messages: ChatMessage[] = []

    persistVerifyGapControl(ordinary, ordinary.produced, messages)
    expect(messages).toHaveLength(0)

    // A VERIFY failure that is not a structural verdict (a decode failure, say)
    // is retried at its own stage, so the loop gets no instruction either.
    const notStructural = structuredGapContext()
    notStructural.verificationHistory = [{ ...notStructural.verificationHistory![0]!, source: 'degraded' }]
    persistVerifyGapControl(notStructural, notStructural.produced, messages)
    expect(messages).toHaveLength(0)

    // The gap record alone is not enough: this loop was entered for something
    // else (a spent budget, a fresh run), so the message would be a lie.
    const wrongStage = structuredGapContext()
    wrongStage.lastError = { stage: 'execute', message: 'llm call failed: 502' }
    persistVerifyGapControl(wrongStage, wrongStage.produced, messages)
    expect(messages).toHaveLength(0)
  })
})
