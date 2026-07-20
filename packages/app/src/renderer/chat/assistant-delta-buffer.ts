// Display-synced buffering for high-frequency model text deltas.
export type AssistantDeltaFrameScheduler = (callback: () => void) => () => void


export interface AssistantDeltaBuffer {
  push(delta: string): void
  flush(): void
  clear(): void
  dispose(): void
}


export function createAssistantDeltaBuffer(
  onFlush: (delta: string) => void,
  scheduleFrame: AssistantDeltaFrameScheduler = scheduleDisplayFrame,
): AssistantDeltaBuffer {
  let pending = ''
  let cancelScheduled: (() => void) | undefined

  const drain = () => {
    cancelScheduled = undefined
    if (!pending) return
    const delta = pending
    pending = ''
    onFlush(delta)
  }

  const clear = () => {
    cancelScheduled?.()
    cancelScheduled = undefined
    pending = ''
  }

  return {
    push(delta) {
      if (!delta) return
      pending += delta
      if (cancelScheduled) return
      cancelScheduled = scheduleFrame(drain)
    },
    flush() {
      cancelScheduled?.()
      cancelScheduled = undefined
      drain()
    },
    clear,
    dispose: clear,
  }
}


function scheduleDisplayFrame(callback: () => void): () => void {
  if (
    typeof window !== 'undefined'
    && typeof window.requestAnimationFrame === 'function'
    && !window.document.hidden
  ) {
    const handle = window.requestAnimationFrame(callback)
    return () => window.cancelAnimationFrame(handle)
  }
  const handle = setTimeout(callback, 16)
  return () => clearTimeout(handle)
}
