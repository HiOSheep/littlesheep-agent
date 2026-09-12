import { describe, expect, it } from 'vitest'
import type { AgentTool, DurableHarnessEventAppendInput } from '@littlesheep/types'
import { makeCtx } from '../../tests/helpers.js'
import { beginSideEffect, describeSideEffect } from './side-effect-ledger.js'

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
