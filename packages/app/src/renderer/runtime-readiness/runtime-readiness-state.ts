// Shared observer for the Main-process execution readiness.
//
// Two different consumers need the same fact: the shell renders it, and the
// startup checkpoint recovery must not run before execution is available. A
// React prop chain between them would couple unrelated domains, so the bridge
// is observed once here and both consumers subscribe to this store instead.
//
// Subscribe first, then repair with a query: a transition that lands between
// the two is delivered by the listener, and one that already happened is
// returned by the query.

import type { RuntimeReadiness } from '../../shared/runtime-readiness-contracts'

type ReadinessListener = (state: RuntimeReadiness) => void

let currentReadiness: RuntimeReadiness | undefined
let queried = false
const listeners = new Set<ReadinessListener>()
let bridgeSubscribed = false

function readBridge() {
  return typeof window === 'undefined' ? undefined : window.littlesheep
}

function publish(next: RuntimeReadiness): void {
  currentReadiness = next
  for (const listener of [...listeners]) listener(next)
}

function ensureBridgeSubscription(): void {
  if (bridgeSubscribed) return
  const bridge = readBridge()
  if (!bridge?.onRuntimeReadiness) return
  bridgeSubscribed = true
  bridge.onRuntimeReadiness(publish)
}

function ensureQueried(): void {
  if (queried) return
  const bridge = readBridge()
  if (!bridge?.getRuntimeReadiness) return
  queried = true
  void bridge.getRuntimeReadiness()
    .then((snapshot) => {
      if (snapshot) publish(snapshot)
    })
    .catch(() => undefined)
}

/** Latest known readiness. Undefined until the first snapshot arrives. */
export function currentRuntimeReadiness(): RuntimeReadiness | undefined {
  ensureBridgeSubscription()
  ensureQueried()
  return currentReadiness
}

/** Subscribe to readiness transitions; returns the unsubscribe function. */
export function subscribeRuntimeReadiness(listener: ReadinessListener): () => void {
  ensureBridgeSubscription()
  ensureQueried()
  listeners.add(listener)
  if (currentReadiness) listener(currentReadiness)
  return () => {
    listeners.delete(listener)
  }
}

/** True only when the Runtime reports execution is possible. */
export function isExecutionReady(): boolean {
  return currentRuntimeReadiness()?.state === 'ready'
}

/**
 * Resolve once execution is available, or once it has failed, or on timeout.
 *
 * Callers whose work needs the Runner - loading a conversation's history, for
 * example - await this instead of attempting the call during the deliberately
 * interactive not-ready window and rendering its 503 as a failure. It queries the
 * bridge first, because the cached state is populated asynchronously and would
 * otherwise look "unknown" on the very first call. An environment without a
 * bridge (a unit test, a non-Electron host) resolves immediately: it cannot
 * report readiness, so it must not block, and the caller keeps its old behaviour.
 */
export async function waitForExecutionReady(timeoutMs = 30_000): Promise<RuntimeReadiness | undefined> {
  const bridge = readBridge()
  if (!bridge?.getRuntimeReadiness) return undefined
  ensureBridgeSubscription()
  const snapshot = await bridge.getRuntimeReadiness().catch(() => undefined)
  if (snapshot) publish(snapshot)
  const settled = currentReadiness
  if (settled === undefined) return undefined
  if (settled.state === 'ready' || settled.state === 'failed') return settled
  return new Promise((resolve) => {
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    const finish = (state: RuntimeReadiness | undefined) => {
      if (finished) return
      finished = true
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      resolve(state)
    }
    timer = setTimeout(() => finish(undefined), timeoutMs)
    unsubscribe = subscribeRuntimeReadiness((state) => {
      if (state.state === 'ready' || state.state === 'failed') finish(state)
    })
    // `subscribeRuntimeReadiness` publishes the current state synchronously, so
    // the wait can already be over before the real unsubscribe was returned.
    if (finished) unsubscribe()
  })
}

export type { RuntimeReadiness }
