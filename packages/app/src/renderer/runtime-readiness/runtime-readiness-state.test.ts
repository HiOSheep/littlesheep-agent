// The wait that keeps Runner-backed work out of the not-ready window.
//
// The module keeps its state at file scope, so each test imports a fresh copy
// after installing the bridge stub it wants to observe.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeReadiness } from '../../shared/runtime-readiness-contracts'

type BridgeStub = {
  publish: (state: RuntimeReadiness) => void
  current: RuntimeReadiness | undefined
}

function installBridge(initial?: RuntimeReadiness): BridgeStub {
  const listeners = new Set<(state: RuntimeReadiness) => void>()
  const stub: BridgeStub = {
    current: initial,
    publish: (state) => {
      stub.current = state
      for (const listener of [...listeners]) listener(state)
    },
  }
  vi.stubGlobal('window', {
    littlesheep: {
      onRuntimeReadiness: (listener: (state: RuntimeReadiness) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getRuntimeReadiness: async () => stub.current,
    },
  })
  return stub
}

async function loadModule() {
  vi.resetModules()
  return import('./runtime-readiness-state')
}

function ready(): RuntimeReadiness {
  return { apiVersion: 1, state: 'ready', phase: 'execution', retryable: false }
}

function starting(): RuntimeReadiness {
  return { apiVersion: 1, state: 'starting', phase: 'execution', reason: '正在准备运行能力', retryable: true }
}

function failed(): RuntimeReadiness {
  return { apiVersion: 1, state: 'failed', phase: 'execution', reason: '没有可用模型', retryable: true }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('waitForExecutionReady', () => {
  it('resolves immediately when readiness is unknown', async () => {
    vi.stubGlobal('window', undefined)
    const { waitForExecutionReady } = await loadModule()

    await expect(waitForExecutionReady(5_000)).resolves.toBeUndefined()
  })

  it('resolves immediately when execution is already available or already failed', async () => {
    installBridge(ready())
    const first = await loadModule()
    await expect(first.waitForExecutionReady(5_000)).resolves.toMatchObject({ state: 'ready' })

    installBridge(failed())
    const second = await loadModule()
    await expect(second.waitForExecutionReady(5_000)).resolves.toMatchObject({ state: 'failed' })
  })

  it('resolves on the transition instead of hanging until the timeout', async () => {
    const bridge = installBridge(starting())
    const { waitForExecutionReady } = await loadModule()

    const waiting = waitForExecutionReady(30_000)
    bridge.publish(ready())

    await expect(waiting).resolves.toMatchObject({ state: 'ready' })
  })

  it('gives up on the timeout when readiness never changes', async () => {
    installBridge(starting())
    const { waitForExecutionReady } = await loadModule()
    vi.useFakeTimers()

    const waiting = waitForExecutionReady(1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(waiting).resolves.toBeUndefined()
  })
})
