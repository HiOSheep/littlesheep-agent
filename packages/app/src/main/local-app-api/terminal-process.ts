// PTY-first workspace terminal process adapter with a spawn fallback.

import { spawn } from 'node:child_process'
import { workspaceShellConfig } from '../workspace-shell.js'
import { HttpError } from './http.js'

export interface WorkspaceTerminalProcess {
  readonly kind: 'pty' | 'spawn'
  readonly label: string
  write(data: string): void
  resize(cols: number, rows: number): void
  interrupt(): void
  kill(): void
  dispose(): void
  onData(listener: (stream: 'stdout' | 'stderr', text: string) => void): () => void
  onExit(listener: (event: { exitCode: number | null; signal: string | null }) => void): () => void
  onError(listener: (error: Error) => void): () => void
}

type NodePtyModule = typeof import('node-pty')
let nodePtyModulePromise: Promise<NodePtyModule | null> | null = null

export async function createWorkspaceTerminalProcess(
  root: string,
  size: { cols: number; rows: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceTerminalProcess> {
  const pty = await loadNodePty()
  if (pty) {
    try {
      return createPtyTerminalProcess(pty, root, size, env)
    } catch (error) {
      console.warn(`[workspace-terminal] node-pty failed, falling back to spawn: ${(error as Error).message}`)
    }
  }
  return createSpawnTerminalProcess(root, env)
}

async function loadNodePty(): Promise<NodePtyModule | null> {
  if (!nodePtyModulePromise) {
    nodePtyModulePromise = import('node-pty').catch((error) => {
      console.warn(`[workspace-terminal] node-pty unavailable, falling back to spawn: ${(error as Error).message}`)
      return null
    })
  }
  return nodePtyModulePromise
}

function createPtyTerminalProcess(
  pty: NodePtyModule,
  root: string,
  size: { cols: number; rows: number },
  env: NodeJS.ProcessEnv,
): WorkspaceTerminalProcess {
  const shellConfig = workspaceShellConfig()
  const terminal = pty.spawn(shellConfig.command, shellConfig.args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: root,
    env,
    encoding: process.platform === 'win32' ? undefined : 'utf8',
    useConpty: process.platform === 'win32' ? true : undefined,
    useConptyDll: process.platform === 'win32' ? true : undefined,
  })
  const dataListeners = new Set<(stream: 'stdout' | 'stderr', text: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number | null; signal: string | null }) => void>()
  let disposed = false
  const dataDisposable = terminal.onData((text) => {
    if (disposed) return
    for (const listener of dataListeners) listener('stdout', text)
  })
  const exitDisposable = terminal.onExit((event) => {
    if (disposed) return
    const signal = event.signal === undefined ? null : String(event.signal)
    for (const listener of exitListeners) listener({ exitCode: event.exitCode, signal })
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    dataListeners.clear()
    exitListeners.clear()
    dataDisposable.dispose()
    exitDisposable.dispose()
  }
  return {
    kind: 'pty',
    label: `${shellConfig.label} PTY`,
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    interrupt: () => terminal.write('\x03'),
    kill: () => {
      terminal.kill()
      dispose()
    },
    dispose,
    onData: (listener) => {
      dataListeners.add(listener)
      return () => dataListeners.delete(listener)
    },
    onExit: (listener) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    onError: () => () => undefined,
  }
}

function createSpawnTerminalProcess(root: string, env: NodeJS.ProcessEnv): WorkspaceTerminalProcess {
  const shellConfig = workspaceShellConfig()
  const child = spawn(shellConfig.command, shellConfig.args, {
    cwd: root,
    env,
    windowsHide: true,
  })
  const dataListeners = new Set<(stream: 'stdout' | 'stderr', text: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number | null; signal: string | null }) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  let disposed = false
  const onStdout = (chunk: Buffer) => {
    if (disposed) return
    for (const listener of dataListeners) listener('stdout', chunk.toString('utf8'))
  }
  const onStderr = (chunk: Buffer) => {
    if (disposed) return
    for (const listener of dataListeners) listener('stderr', chunk.toString('utf8'))
  }
  child.stdout?.on('data', onStdout)
  child.stderr?.on('data', onStderr)
  const onError = (error: Error) => {
    if (disposed) return
    for (const listener of errorListeners) listener(error)
  }
  child.once('error', onError)
  const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (disposed) return
    for (const listener of exitListeners) listener({ exitCode, signal })
  }
  child.once('close', onClose)
  const dispose = () => {
    if (disposed) return
    disposed = true
    dataListeners.clear()
    exitListeners.clear()
    errorListeners.clear()
    child.stdout?.off('data', onStdout)
    child.stderr?.off('data', onStderr)
    child.off('error', onError)
    child.off('close', onClose)
  }
  return {
    kind: 'spawn',
    label: `${shellConfig.label} fallback`,
    write: (data) => {
      const stdin = child.stdin
      if (!stdin?.writable) throw new HttpError(410, 'terminal session has exited')
      stdin.write(data)
    },
    resize: () => undefined,
    interrupt: () => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        return
      }
      child.kill('SIGINT')
    },
    kill: () => {
      killSpawnedProcessTree(child)
      dispose()
    },
    dispose,
    onData: (listener) => {
      dataListeners.add(listener)
      return () => dataListeners.delete(listener)
    },
    onExit: (listener) => {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    onError: (listener) => {
      errorListeners.add(listener)
      return () => errorListeners.delete(listener)
    },
  }
}

function killSpawnedProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid
  if (process.platform === 'win32' && pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    killer.once('error', () => child.kill())
    killer.once('close', () => child.kill())
    return
  }
  child.kill()
}
