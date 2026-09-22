import { describe, expect, it } from 'vitest'
import { toolResultForModel } from './tool-result-persistence.js'

describe('tool result projection for the model', () => {
  it('keeps a successful call output and omits the error field', () => {
    const projected = JSON.parse(toolResultForModel({
      callId: 'c1',
      ok: true,
      output: 'alpha.txt',
    })) as Record<string, unknown>

    expect(projected).toMatchObject({ ok: true, status: 'succeeded', output: 'alpha.txt' })
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
    expect(projected).toMatchObject({
      ok: false,
      status: 'failed',
      error: 'exit code 1',
      output: 'not ok 1 - releases the reservation\n  expected: 2\n  actual: 0',
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

    expect(projected).toMatchObject({ output: 'bounded output', sanitized: true })
  })

  it('omits an empty output instead of sending an empty string', () => {
    const projected = JSON.parse(toolResultForModel({ callId: 'c1', ok: false, error: 'denied' })) as Record<string, unknown>
    expect(projected.output).toBeUndefined()
    expect(projected.error).toBe('denied')
  })
})
