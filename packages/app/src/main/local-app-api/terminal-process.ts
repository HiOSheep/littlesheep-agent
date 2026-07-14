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
  onData(listener: (stream: 'stdout' | 'stderr', text: string) => void): void
  onExit(listener: (event: { exitCode: number | null; signal: string | null }) => void): void
  onError(listener: (error: Error) => void): void
}

type NodePtyModule = typeof import('node-pty')
let nodePtyModulePromise: Promise<NodePtyModule | null> | null = null

export async function createWorkspaceTerminalProcess(
  root: string,
  size: { cols: number; rows: number },
): Promise<WorkspaceTerminalProcess> {
  const pty = await loadNodePty()
  if (pty) {
    try {
      return createPtyTerminalProcess(pty, root, size)
    } catch (error) {
      console.warn(`[workspace-terminal] node-pty failed, falling back to spawn: ${(error as Error).message}`)
    }
  }
  return createSpawnTerminalProcess(root)
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
): WorkspaceTerminalProcess {
  const shellConfig = workspaceShellConfig()
  const terminal = pty.spawn(shellConfig.command, shellConfig.args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: root,
    env: process.env,
    encoding: process.platform === 'win32' ? undefined : 'utf8',
    useConpty: process.platform === 'win32' ? true : undefined,
    useConptyDll: process.platform === 'win32' ? true : undefined,
  })
  const dataListeners = new Set<(stream: 'stdout' | 'stderr', text: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number | null; signal: string | null }) => void>()
  terminal.onData((text) => {
    for (const listener of dataListeners) listener('stdout', text)
  })
  terminal.onExit((event) => {
    const signal = event.signal === undefined ? null : String(event.signal)
    for (const listener of exitListeners) listener({ exitCode: event.exitCode, signal })
  })
  return {
    kind: 'pty',
    label: `${shellConfig.label} PTY`,
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    interrupt: () => terminal.write('\x03'),
    kill: () => terminal.kill(),
    onData: (listener) => { dataListeners.add(listener) },
    onExit: (listener) => { exitListeners.add(listener) },
    onError: () => undefined,
  }
}

function createSpawnTerminalProcess(root: string): WorkspaceTerminalProcess {
  const shellConfig = workspaceShellConfig()
  const child = spawn(shellConfig.command, shellConfig.args, {
    cwd: root,
    env: process.env,
    windowsHide: true,
  })
  const dataListeners = new Set<(stream: 'stdout' | 'stderr', text: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number | null; signal: string | null }) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const listener of dataListeners) listener('stdout', chunk.toString('utf8'))
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const listener of dataListeners) listener('stderr', chunk.toString('utf8'))
  })
  child.once('error', (error) => {
    for (const listener of errorListeners) listener(error)
  })
  child.once('close', (exitCode, signal) => {
    for (const listener of exitListeners) listener({ exitCode, signal })
  })
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
    kill: () => killSpawnedProcessTree(child),
    onData: (listener) => { dataListeners.add(listener) },
    onExit: (listener) => { exitListeners.add(listener) },
    onError: (listener) => { errorListeners.add(listener) },
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
