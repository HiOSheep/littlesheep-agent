import { describe, expect, it } from 'vitest'
import type { AgentTool, DurableHarnessEventAppendInput, ToolExecutionLifecycleContext } from '@littlesheep/types'
import { makeCtx } from '../../tests/helpers.js'
import {
  beginSideEffect,
  describeSideEffect,
  finishSideEffect,
  settlementForResult,
} from './side-effect-ledger.js'
import { createSideEffectLifecycle } from './side-effect-lifecycle.js'

const writeResource = [{ key: 'workspace:ledger', mode: 'write' as const }]
const readResource = [{ key: 'fs:workspace', mode: 'read' as const }]

function probeTool(reconciliationKey?: AgentTool['reconciliationKey'], name = 'mutate_probe'): AgentTool {
  return {
    name,
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

/** The same probe, declaring that a repeat after an observed change can be a new operation. */
function reRunnableProbeTool(name = 'mutate_probe'): AgentTool {
  return { ...probeTool(undefined, name), reRunnableAfterResourceChange: true }
}

// HC-04: a settled success refuses a replay — unless the Runtime recorded a change to the operation's own
// subject after it settled. The warrant is the ledger's own evidence (a later successful effect on one of
// the same write resources), never the model asking twice.
describe('repeating a call whose earlier attempt succeeded', () => {
  it('grants a fresh execution identity when the run recorded a later change to the same resource', async () => {
    const { ctx, appended } = recordingCtx()
    const tool = reRunnableProbeTool()
    const verify = describeSideEffect(tool, { value: 'check' }, writeResource, undefined, 'call-1')!
    expect((await beginSideEffect(ctx, verify)).kind).toBe('started')
    await finishSideEffect(ctx, verify, { callId: 'call-1', ok: true })

    // The verification now replays before anything changed: still refused.
    expect((await beginSideEffect(ctx, { ...verify, callId: 'call-2' })).kind).toBe('duplicate')

    // A later, settled-successful mutation of the same resource is the recorded change.
    const mutate = describeSideEffect(tool, { value: 'change' }, writeResource, undefined, 'call-3')!
    expect((await beginSideEffect(ctx, mutate)).kind).toBe('started')
    await finishSideEffect(ctx, mutate, { callId: 'call-3', ok: true })

    const again = await beginSideEffect(ctx, { ...verify, callId: 'call-4' })
    expect(again.kind).toBe('started')
    if (again.kind !== 'started') throw new Error('expected the warranted repeat to start')
    expect(again.descriptor.idempotencyKey).toBe(`${verify.idempotencyKey}:retry1`)
    // The warrant is on the durable intent of the attempt it authorized, so an audit can tell a granted
    // repeat from a replay.
    expect(appended.at(-1)?.payload).toMatchObject({
      effectId: `${verify.idempotencyKey}:retry1`,
      evidenceRef: `warrant:resource-changed:${mutate.idempotencyKey}`,
    })
    await finishSideEffect(ctx, again.descriptor, { callId: 'call-4', ok: true })

    // Two independent executions are on the record, each settled once.
    expect(ctx.sideEffects?.map((effect) => effect.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    // Two independent executions of the *same* operation: its first attempt and the warranted retry.
    expect(ctx.sideEffects?.filter((effect) => (
      effect.idempotencyKey === verify.idempotencyKey
      || effect.idempotencyKey === `${verify.idempotencyKey}:retry1`
    ))).toHaveLength(2)
  })

  it('refuses the repeat when the change was recorded before the settled attempt', async () => {
    const { ctx } = recordingCtx()
    const tool = reRunnableProbeTool()
    const mutate = describeSideEffect(tool, { value: 'change' }, writeResource, undefined, 'call-1')!
    await beginSideEffect(ctx, mutate)
    await finishSideEffect(ctx, mutate, { callId: 'call-1', ok: true })

    const verify = describeSideEffect(tool, { value: 'check' }, writeResource, undefined, 'call-2')!
    expect((await beginSideEffect(ctx, verify)).kind).toBe('started')
    await finishSideEffect(ctx, verify, { callId: 'call-2', ok: true })

    // Nothing happened after the verification settled, so this is the replay the ledger refuses.
    const replay = await beginSideEffect(ctx, { ...verify, callId: 'call-3' })
    expect(replay.kind).toBe('duplicate')
  })

  it('keeps refusing for a tool that never declared the capability, and for an unknown effect kind', async () => {
    const { ctx } = recordingCtx()
    const plain = probeTool()
    const settle = async (tool: AgentTool, value: string, callId: string) => {
      const descriptor = describeSideEffect(tool, { value }, writeResource, undefined, callId)!
      expect((await beginSideEffect(ctx, descriptor)).kind).toBe('started')
      await finishSideEffect(ctx, descriptor, { callId, ok: true })
      return descriptor
    }
    const first = await settle(plain, 'check', 'call-1')
    await settle(plain, 'change', 'call-2')
    expect((await beginSideEffect(ctx, { ...first, callId: 'call-3' })).kind).toBe('duplicate')

    // An effect the Runtime could not classify is never re-run on this warrant.
    const opaque = describeSideEffect(reRunnableProbeTool('opaque_probe'), { value: 'check' }, [], undefined, 'call-4')!
    expect(opaque.effectKind).toBe('unknown')
    await beginSideEffect(ctx, opaque)
    await finishSideEffect(ctx, opaque, { callId: 'call-4', ok: true })
    const opaqueChange = describeSideEffect(reRunnableProbeTool('opaque_probe'), { value: 'change' }, [], undefined, 'call-5')!
    await beginSideEffect(ctx, opaqueChange)
    await finishSideEffect(ctx, opaqueChange, { callId: 'call-5', ok: true })
    expect((await beginSideEffect(ctx, { ...opaque, callId: 'call-6' })).kind).toBe('duplicate')
  })
})

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

// CE-06: a repeated *observation* is not a replay. The exemption is not a
// heuristic about the command text: a tool the Runtime can prove is read-only
// (it declared only read resources) never reaches the ledger at all, while an
// opaque command stays opaque however harmless its first word looks.
describe('observations versus effects', () => {
  it('keeps a proven read-only tool out of the ledger entirely', () => {
    // Declared read-only resources are proof, whatever the tool is called.
    for (const name of ['glob', 'grep', 'read', 'inspect_probe']) {
      expect(describeSideEffect(probeTool(undefined, name), { path: '.' }, readResource, undefined, 'call-1'))
        .toBeUndefined()
    }
    // The Runtime's own read-only names need no declaration at all.
    for (const name of ['glob', 'grep', 'read', 'memory_tree', 'session_status']) {
      expect(describeSideEffect(probeTool(undefined, name), {}, [], undefined, 'call-1'))
        .toBeUndefined()
    }
    // Anything the Runtime cannot place stays conservative.
    expect(describeSideEffect(probeTool(undefined, 'inspect_probe'), {}, [], undefined, 'call-1'))
      .toMatchObject({ effectKind: 'unknown' })
  })

  it('treats an opaque command as an effect even when it reads like a listing', async () => {
    const { ctx } = recordingCtx()
    const descriptor = describeSideEffect(
      probeTool(undefined, 'exec'),
      { command: 'Get-ChildItem -LiteralPath .' },
      [],
      undefined,
      'call-1',
    )

    expect(descriptor).toMatchObject({ effectKind: 'external', resourceKeys: [] })
    // Succeeding once is what makes the repeat a replay; the command *text* is
    // never consulted, so `dir` gets no more credit than any other command.
    expect((await beginSideEffect(ctx, descriptor!)).kind).toBe('started')
    await finishSideEffect(ctx, descriptor!, { callId: 'call-1', ok: true })
    const repeated = await beginSideEffect(ctx, { ...descriptor!, callId: 'call-2' })
    expect(repeated.kind).toBe('duplicate')
  })

  it('names the structured alternative when it refuses a replay', async () => {
    const ctx = makeCtx()
    const lifecycle = createSideEffectLifecycle(ctx)
    const tool = probeTool(undefined, 'exec')
    const first: ToolExecutionLifecycleContext = {
      request: { callId: 'call-1', name: 'exec' },
      tool,
      toolSource: 'builtin',
      input: { command: 'Get-ChildItem .' },
      resources: [],
    }

    expect(await lifecycle.beforeInvoke?.(first)).toBeUndefined()
    await lifecycle.afterInvoke?.(first, { callId: 'call-1', ok: true }, { status: 'succeeded' })

    const second = await lifecycle.beforeInvoke?.({ ...first, request: { callId: 'call-2', name: 'exec' } })
    expect(second?.errorKind).toBe('side_effect_replay')
    expect(second?.result.ok).toBe(false)
    expect(String(second?.result.error)).toContain('refusing to replay')
    expect(String(second?.result.error)).toContain('`glob`')
  })
})
