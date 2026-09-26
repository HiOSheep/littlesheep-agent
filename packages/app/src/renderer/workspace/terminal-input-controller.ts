// Bounded raw-input queue for the interactive workspace terminal.

import { writeWorkspaceTerminalInput } from '../api'

const INPUT_FLUSH_DELAY_MS = 8

export interface TerminalInputControllerOptions {
  getTerminalSessionId: () => string
  getAppSessionId: () => string | undefined
  isDisposed: () => boolean
  writeLine: (line: string) => void
  setStatus: (status: string) => void
  onCompletedCommand: () => void
}

export interface TerminalInputController {
  queue(data: string): void
  drain(): Promise<void>
  reset(): void
  dispose(): void
}

export function createTerminalInputController(
  options: TerminalInputControllerOptions,
): TerminalInputController {
  let pending = ''
  let flushTimer: number | null = null
  let drainPromise: Promise<void> | null = null
  let generation = 0
  let disposed = false

  function inactive(): boolean {
    return disposed || options.isDisposed()
  }

  function queue(data: string): void {
    if (!data || inactive()) return
    pending += data
    if (/[\r\n]/u.test(data)) {
      clearFlushTimer()
      void drain()
      return
    }
    if (flushTimer === null) {
      flushTimer = window.setTimeout(() => {
        flushTimer = null
        void drain()
      }, INPUT_FLUSH_DELAY_MS)
    }
  }

  async function drain(): Promise<void> {
    if (drainPromise) return drainPromise
    const currentGeneration = generation
    const task = (async () => {
      while (!inactive() && currentGeneration === generation && pending) {
        const terminalSessionId = options.getTerminalSessionId()
        if (!terminalSessionId) return
        const data = pending
        pending = ''
        let completed = 0
        try {
          ({ completed } = await writeWorkspaceTerminalInput(
            terminalSessionId,
            data,
            options.getAppSessionId(),
          ))
        } catch (error) {
          if (inactive() || currentGeneration !== generation) return
          options.writeLine(`\x1b[31m${(error as Error).message}\x1b[0m`)
          options.setStatus('输入失败')
          continue
        }
        if (inactive() || currentGeneration !== generation) return
        if (completed > 0) {
          options.setStatus('终端就绪')
          options.onCompletedCommand()
        }
      }
    })()
    drainPromise = task
    try {
      await task
    } finally {
      if (drainPromise === task) {
        drainPromise = null
        if (pending && options.getTerminalSessionId() && !inactive()) void drain()
      }
    }
  }

  function reset(): void {
    generation += 1
    pending = ''
    clearFlushTimer()
  }

  function dispose(): void {
    disposed = true
    reset()
  }

  function clearFlushTimer(): void {
    if (flushTimer === null) return
    window.clearTimeout(flushTimer)
    flushTimer = null
  }

  return { queue, drain, reset, dispose }
}
