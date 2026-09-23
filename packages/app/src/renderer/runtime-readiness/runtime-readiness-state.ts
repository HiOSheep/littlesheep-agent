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

export type { RuntimeReadiness }
