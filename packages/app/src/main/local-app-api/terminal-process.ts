// PTY-first workspace terminal process adapter with a spawn fallback.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { workspaceShellConfig } from '../workspace-shell.js'
import { wslArgs, type WorkspaceShellProfile } from '../workspace-shell-discovery.js'
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
  /** The discovered Shell to run; Main resolves it and the renderer only sends an id. */
  profile?: WorkspaceShellProfile | null,
): Promise<WorkspaceTerminalProcess> {
  const shell = shellLaunch(profile, root)
  // A discovered shell that has since been removed must fail here, with a message the UI can
  // show, instead of starting a process that never runs (`spawn` reports a missing executable
  // asynchronously, which used to leave a session that looked alive and could not be killed).
  if (profile?.executable && !existsSync(profile.executable)) {
    throw new HttpError(400, `Shell 可执行文件不存在：${profile.executable}`)
  }
  const pty = await loadNodePty()
  if (pty) {
    try {
      return createPtyTerminalProcess(pty, root, size, env, shell)
    } catch (error) {
      console.warn(`[workspace-terminal] node-pty failed, falling back to spawn: ${(error as Error).message}`)
    }
  }
  return createSpawnTerminalProcess(root, env, shell)
}

/**
 * The executable, arguments and environment a session starts with.
 *
 * A discovered profile wins; without one the previous behaviour (Windows PowerShell on
 * Windows, $SHELL elsewhere) is kept, so existing sessions migrate unchanged.
 */
export function shellLaunch(
  profile?: WorkspaceShellProfile | null,
  workspacePath?: string,
): {
  command: string
  args: string[]
  env: Record<string, string>
  label: string
} {
  if (profile?.available && profile.executable) {
    // WSL starts in a Linux directory, so its `--cd` depends on where this session runs —
    // arguments cannot be frozen at discovery time for that shell (UX-29 item 3).
    const args = profile.kind === 'wsl' && profile.distro
      ? wslArgs(profile.distro, workspacePath)
      : profile.args ?? []
    return {
      command: profile.executable,
      args,
      env: profile.env ?? {},
      label: profile.label,
    }
  }
  const fallback = workspaceShellConfig()
  return { command: fallback.command, args: fallback.args, env: {}, label: fallback.label }
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
  shell: { command: string; args: string[]; env: Record<string, string>; label: string },
): WorkspaceTerminalProcess {
  const terminal = pty.spawn(shell.command, shell.args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: root,
    env: { ...env, ...shell.env },
    encoding: process.platform === 'win32' ? undefined : 'utf8',
    useConpty: process.platform === 'win32' ? true : undefined,
    useConptyDll: process.platform === 'win32' ? true : undefined,
  })
  const dataListeners = new Set<(stream: 'stdout' | 'stderr', text: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number | null; signal: string | null }) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  let disposed = false
  let closing = false
  const emitError = (value: unknown) => {
    if (disposed) return
    closing = true
    const error = toTerminalError(value)
    for (const listener of errorListeners) listener(error)
  }

  // node-pty's public typings do not expose errors, but the runtime forwards
  // output socket errors through EventEmitter. Keep this listener attached for
  // the lifetime of the PTY so a late ConPTY error cannot become uncaught.
  const onTerminalError = (error: unknown) => emitError(error)
  const runtimeTerminal = terminal as typeof terminal & {
    on?: (event: string, listener: (error: unknown) => void) => unknown
    _agent?: { inSocket?: { on?: (event: string, listener: (error: unknown) => void) => unknown } }
  }
  runtimeTerminal.on?.('error', onTerminalError)
  // Windows ConPTY writes use a private input socket in node-pty 1.x. It has
  // no default error handler, so attach one defensively to consume late EOFs.
  runtimeTerminal._agent?.inSocket?.on?.('error', onTerminalError)

  const dataDisposable = terminal.onData((text) => {
    if (disposed) return
    for (const listener of dataListeners) listener('stdout', text)
  })
  const exitDisposable = terminal.onExit((event) => {
    // Stop accepting input as soon as node-pty reports exit. The underlying
    // ConPTY input socket can close slightly later and reject queued writes.
    closing = true
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
  const safeWrite = (data: string) => {
    if (disposed || closing) throw new HttpError(410, 'terminal session has exited')
    try {
      terminal.write(data)
    } catch (error) {
      emitError(error)
      throw terminalClosedError(error)
    }
  }
  return {
    kind: 'pty',
    label: `${shell.label} PTY`,
    write: safeWrite,
    resize: (cols, rows) => {
      if (disposed || closing) throw new HttpError(410, 'terminal session has exited')
      try {
        terminal.resize(cols, rows)
      } catch (error) {
        emitError(error)
        throw terminalClosedError(error)
      }
    },
    interrupt: () => safeWrite('\x03'),
    kill: () => {
      if (disposed) return
      closing = true
      try {
        terminal.kill()
      } catch (error) {
        emitError(error)
      } finally {
        dispose()
      }
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

function createSpawnTerminalProcess(
  root: string,
  env: NodeJS.ProcessEnv,
  shell: { command: string; args: string[]; env: Record<string, string>; label: string },
): WorkspaceTerminalProcess {
  const child = spawn(shell.command, shell.args, {
    cwd: root,
    env: { ...env, ...shell.env },
    windowsHide: true,
  })
  const dataListeners = new Set<(stream: 'stdout' | 'stderr', text: string) => void>()
  const exitListeners = new Set<(event: { exitCode: number | null; signal: string | null }) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  let disposed = false
  let closing = false
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
    closing = true
    for (const listener of errorListeners) listener(toTerminalError(error))
  }
  // Keep the process error listener attached through disposal. A kill can
  // complete asynchronously and removing the last listener reintroduces an
  // uncaught 'error' event on the child process.
  child.on('error', onError)
  const onStdinError = (error: Error) => onError(error)
  child.stdin?.on('error', onStdinError)
  const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    closing = true
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
    child.off('close', onClose)
  }
  return {
    kind: 'spawn',
    label: `${shell.label} fallback`,
    write: (data) => {
      const stdin = child.stdin
      if (
        disposed
        || closing
        || !stdin?.writable
        || stdin.destroyed
        || stdin.writableEnded
        || stdin.writableFinished
      ) {
        throw new HttpError(410, 'terminal session has exited')
      }
      try {
        stdin.write(data)
      } catch (error) {
        onError(error as Error)
        throw terminalClosedError(error)
      }
    },
    resize: () => undefined,
    interrupt: () => {
      if (disposed || closing) return
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        return
      }
      child.kill('SIGINT')
    },
    kill: () => {
      if (disposed) return
      closing = true
      try {
        killSpawnedProcessTree(child)
      } finally {
        dispose()
      }
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

function toTerminalError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === 'string' ? value : 'terminal process failed')
}

function terminalClosedError(value: unknown): Error {
  const error = toTerminalError(value)
  const code = typeof (error as NodeJS.ErrnoException).code === 'string'
    ? (error as NodeJS.ErrnoException).code!.toUpperCase()
    : ''
  const message = error.message.toLowerCase()
  if (
    code === 'EOP'
    || code === 'EPIPE'
    || code === 'EOF'
    || code === 'EIO'
    || code === 'ERR_STREAM_DESTROYED'
    || code === 'ERR_STREAM_WRITE_AFTER_END'
    || message.includes('eof')
    || message.includes('eio')
    || message.includes('eop')
    || message.includes('epipe')
    || message.includes('closed')
    || message.includes('broken pipe')
  ) {
    return new HttpError(410, 'terminal session has exited')
  }
  return error
}

function killSpawnedProcessTree(child: ReturnType<typeof spawn>): void {
  // Killing must never throw. A process that failed to start has no usable pid, and `kill` on
  // it raises EINVAL — which used to escape from terminal shutdown (measured while accepting
  // a shell whose executable had been removed).
  const safeKill = () => {
    try {
      child.kill()
    } catch {
      // Already gone, or never started.
    }
  }
  const pid = child.pid
  if (process.platform === 'win32' && pid) {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      killer.once('error', safeKill)
      killer.once('close', safeKill)
    } catch {
      safeKill()
    }
    return
  }
  safeKill()
}
