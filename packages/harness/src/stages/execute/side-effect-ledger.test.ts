import { describe, expect, it } from 'vitest'
import type { AgentTool, DurableHarnessEventAppendInput } from '@littlesheep/types'
import { makeCtx } from '../../tests/helpers.js'
import {
  beginSideEffect,
  describeSideEffect,
  finishSideEffect,
  settlementForResult,
} from './side-effect-ledger.js'

const writeResource = [{ key: 'workspace:ledger', mode: 'write' as const }]

function probeTool(reconciliationKey?: AgentTool['reconciliationKey']): AgentTool {
  return {
    name: 'mutate_probe',
    description: 'ledger probe',
    inputSchema: { parse: (input: unknown) => input, jsonSchema: { type: 'object' } },
    async execute() {
      return { callId: '', ok: true }
    },
    ...(reconciliationKey ? { reconciliationKey } : {}),
  }
}

function recordingCtx() {
  const ctx = makeCtx()
  const appended: DurableHarnessEventAppendInput[] = []
  ctx.appendDurableEvent = async (input) => {
    appended.push(input)
  }
  return { ctx, appended }
}

describe('side-effect reconciliation keys', () => {
  it('persists the bounded key a tool declares', async () => {
    const { ctx, appended } = recordingCtx()
    const tool = probeTool(() => ({ path: '/tmp/report.txt', attempt: 1 }))
    const descriptor = describeSideEffect(tool, { path: '/tmp/report.txt' }, writeResource, 'step-1', 'call-1')
    expect(descriptor?.reconciliationKey).toEqual({ path: '/tmp/report.txt', attempt: 1 })

    const outcome = await beginSideEffect(ctx, descriptor!)
    expect(outcome.kind).toBe('started')
    expect(appended).toHaveLength(1)
    expect(appended[0]?.type).toBe('effect_intent_created')
    expect(appended[0]?.payload).toMatchObject({
      toolName: 'mutate_probe',
      reconciliationKey: { path: '/tmp/report.txt', attempt: 1 },
    })
  })

  it('omits the key when the tool declares none', async () => {
    const { ctx, appended } = recordingCtx()
    const descriptor = describeSideEffect(probeTool(), {}, writeResource, undefined, 'call-1')
    expect(descriptor?.reconciliationKey).toBeUndefined()
    await beginSideEffect(ctx, descriptor!)
    expect(appended[0]?.payload).not.toHaveProperty('reconciliationKey')
  })

  it('drops an oversized, nested or throwing key instead of persisting it', async () => {
    const projectors: Array<AgentTool['reconciliationKey']> = [
      () => ({ nested: { deep: 'value' } }),
      () => ({ blob: 'x'.repeat(600) }),
      () => {
        throw new Error('projector failed')
      },
    ]
    for (const projector of projectors) {
      const { ctx, appended } = recordingCtx()
      const descriptor = describeSideEffect(probeTool(projector), {}, writeResource, undefined, 'call-1')
      expect(descriptor?.reconciliationKey).toBeUndefined()
      await beginSideEffect(ctx, descriptor!)
      expect(appended[0]?.payload).not.toHaveProperty('reconciliationKey')
    }
  })
})

describe('effect settlement', () => {
  it('separates a determinate failure from a cut-short invocation', () => {
    expect(settlementForResult({ callId: 'c', ok: true })).toBe('succeeded')
    // A tool that returned a failed result reported a known outcome: the command
    // ran, the path was missing, the schema rejected the input.
    expect(settlementForResult({ callId: 'c', ok: false, error: 'exit code 1' })).toBe('failed')
    // A status the service had to synthesize means the tool never reported an
    // outcome and may have applied a partial effect.
    expect(settlementForResult({ callId: 'c', ok: false, error: 'threw' }, { status: 'failed', errorKind: 'tool_error' })).toBe('unknown')
    expect(settlementForResult({ callId: 'c', ok: false, error: 'timed out' }, { status: 'timed_out' })).toBe('unknown')
    expect(settlementForResult({ callId: 'c', ok: false, error: 'aborted' }, { status: 'aborted' })).toBe('unknown')
  })

  it('retries a settled failure under a new attempt id and refuses to replay a success', async () => {
    const { ctx } = recordingCtx()
    const base = describeSideEffect(probeTool(), { value: 'x' }, writeResource, undefined, 'call-1')!

    expect((await beginSideEffect(ctx, base)).kind).toBe('started')
    await finishSideEffect(ctx, base, { callId: 'call-1', ok: false, error: 'exit code 1' })
    expect(ctx.sideEffects?.at(-1)).toMatchObject({ status: 'failed' })

    // The identical invocation is a new attempt, not a replay of a success.
    const retry = await beginSideEffect(ctx, { ...base, callId: 'call-2' })
    expect(retry.kind).toBe('started')
    if (retry.kind !== 'started') throw new Error('expected the retry to start')
    expect(retry.descriptor.idempotencyKey).toBe(`${base.idempotencyKey}:retry1`)
    await finishSideEffect(ctx, retry.descriptor, { callId: 'call-2', ok: true })
    expect(ctx.sideEffects?.map((effect) => effect.status)).toEqual(['failed', 'succeeded'])

    // Once any attempt succeeded, the same operation must not run again.
    const replay = await beginSideEffect(ctx, { ...base, callId: 'call-3' })
    expect(replay.kind).toBe('duplicate')
    expect(replay).toMatchObject({ status: 'succeeded' })
  })

  it('still blocks an ambiguous attempt and keeps retrying after a cancelled one', async () => {
    const { ctx } = recordingCtx()
    const base = describeSideEffect(probeTool(), { value: 'y' }, writeResource, undefined, 'call-1')!

    await beginSideEffect(ctx, base)
    const ambiguous = ctx.sideEffects![0]!
    ambiguous.status = 'unknown'
    const blocked = await beginSideEffect(ctx, { ...base, callId: 'call-2' })
    expect(blocked.kind).toBe('blocked')
    expect(blocked.kind === 'blocked' ? blocked.reason : '').toContain('unknown')

    ambiguous.status = 'cancelled'
    const afterCancel = await beginSideEffect(ctx, { ...base, callId: 'call-3' })
    expect(afterCancel.kind).toBe('started')
    if (afterCancel.kind !== 'started') throw new Error('expected the retry to start')
    expect(afterCancel.descriptor.idempotencyKey).toBe(`${base.idempotencyKey}:retry1`)
  })
})
