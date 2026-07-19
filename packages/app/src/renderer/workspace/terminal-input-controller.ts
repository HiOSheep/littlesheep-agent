// Bounded raw-input queue for the interactive workspace terminal.

import { writeWorkspaceTerminalInput } from '../api'
import type { PermissionModeId } from '../../shared/permission-modes'

const INPUT_FLUSH_DELAY_MS = 8

export interface TerminalInputControllerOptions {
  getTerminalSessionId: () => string
  getAppSessionId: () => string | undefined
  getPermissionMode: () => PermissionModeId
  getWorkspacePath: () => string
  isDisposed: () => boolean
  requestApproval: (detail: unknown) => Promise<boolean>
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
            { permissionMode: options.getPermissionMode(), approved: false },
          ))
        } catch (error) {
          if (inactive() || currentGeneration !== generation) return
          if ((error as { status?: number }).status !== 403) {
            options.writeLine(`\x1b[31m${(error as Error).message}\x1b[0m`)
            options.setStatus('输入失败')
            continue
          }

          options.setStatus('等待批准')
          let approved = false
          try {
            approved = await options.requestApproval({
              action: 'terminal_input',
              command: terminalInputPreview(data),
              cwd: options.getWorkspacePath(),
              root: options.getWorkspacePath(),
              boundary: 'unknown',
            })
          } catch (approvalError) {
            if (inactive() || currentGeneration !== generation) return
            await cancelTerminalLine(terminalSessionId, currentGeneration)
            options.writeLine(`\x1b[31m${(approvalError as Error).message}\x1b[0m`)
            options.setStatus('批准失败')
            continue
          }
          if (inactive() || currentGeneration !== generation) return
          if (!approved) {
            await cancelTerminalLine(terminalSessionId, currentGeneration)
            options.writeLine('\x1b[33m已取消执行。\x1b[0m')
            options.setStatus('已取消')
            continue
          }
          try {
            ({ completed } = await writeWorkspaceTerminalInput(
              terminalSessionId,
              data,
              options.getAppSessionId(),
              { permissionMode: options.getPermissionMode(), approved: true },
            ))
          } catch (retryError) {
            if (inactive() || currentGeneration !== generation) return
            await cancelTerminalLine(terminalSessionId, currentGeneration)
            options.writeLine(`\x1b[31m${(retryError as Error).message}\x1b[0m`)
            options.setStatus('输入失败')
            continue
          }
        }
        if (inactive() || currentGeneration !== generation) return
        if (completed > 0) {
          options.setStatus('PowerShell 就绪')
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

  async function cancelTerminalLine(terminalSessionId: string, currentGeneration: number): Promise<void> {
    pending = ''
    if (
      inactive()
      || currentGeneration !== generation
      || options.getTerminalSessionId() !== terminalSessionId
    ) return
    await writeWorkspaceTerminalInput(
      terminalSessionId,
      '\x03',
      options.getAppSessionId(),
      { permissionMode: options.getPermissionMode(), approved: true },
    ).catch(() => undefined)
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

export function terminalInputPreview(data: string): string {
  const preview = data
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return preview ? preview.slice(0, 240) : '终端输入'
}
