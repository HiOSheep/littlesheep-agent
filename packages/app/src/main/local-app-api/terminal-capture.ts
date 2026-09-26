// Durable activity capture for commands sent through interactive terminal sessions.

import type { TerminalActivityIndex } from '../terminal-activity-index.js'
import { MAX_TERMINAL_OUTPUT_BYTES } from './terminal-command.js'
import type { WorkspaceTerminalSession } from './terminal-session.js'

interface PendingTerminalCommandCapture {
  terminalSessionId: string
  command: string
  cwd: string
  workspacePath: string
  appSessionId?: string
  shell: string
  startedAt: string
  startedAtMs: number
  stdout: string
  stderr: string
  cleanup: () => void
}

export class TerminalCommandCaptureStore {
  private readonly pending = new Map<string, PendingTerminalCommandCapture>()

  start(
    session: WorkspaceTerminalSession,
    command: string,
    appSessionId: string | undefined,
    activityIndex: TerminalActivityIndex,
  ): void {
    const terminalSessionId = session.sessionId
    const startedAtMs = Date.now()
    const capture: PendingTerminalCommandCapture = {
      terminalSessionId,
      command,
      cwd: session.root,
      workspacePath: session.root,
      appSessionId,
      shell: session.shellLabel,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      stdout: '',
      stderr: '',
      cleanup: () => undefined,
    }
    const onStdout = (text: string) => {
      capture.stdout = appendTerminalCaptureText(capture.stdout, text)
    }
    const onStderr = (text: string) => {
      capture.stderr = appendTerminalCaptureText(capture.stderr, text)
    }
    const onExit = (event: { exitCode: number | null; signal: string | null }) => {
      void this.finalize(terminalSessionId, activityIndex, event)
    }
    capture.cleanup = () => {
      session.off('stdout', onStdout)
      session.off('stderr', onStderr)
      session.off('exit', onExit)
    }
    session.on('stdout', onStdout)
    session.on('stderr', onStderr)
    session.once('exit', onExit)
    this.pending.set(terminalSessionId, capture)
  }

  async finalize(
    terminalSessionId: string,
    activityIndex: TerminalActivityIndex,
    result: { exitCode?: number | null; signal?: string | null } = {},
  ): Promise<void> {
    const capture = this.pending.get(terminalSessionId)
    if (!capture) return
    this.pending.delete(terminalSessionId)
    capture.cleanup()
    const endedAtMs = Date.now()
    await activityIndex.append({
      command: capture.command,
      cwd: capture.cwd,
      workspacePath: capture.workspacePath,
      sessionId: capture.appSessionId,
      // The session knows which Shell it really runs, so the history can say where a
      // command ran once several shells are open (UX-30 item 5).
      shell: capture.shell,
      startedAt: capture.startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: endedAtMs - capture.startedAtMs,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? 'captured',
      timedOut: false,
      truncated: false,
      stdout: capture.stdout,
      stderr: capture.stderr,
    })
  }

  stop(): void {
    for (const capture of this.pending.values()) capture.cleanup()
    this.pending.clear()
  }
}

function appendTerminalCaptureText(current: string, chunk: string): string {
  const next = current + chunk
  if (next.length <= MAX_TERMINAL_OUTPUT_BYTES) return next
  return next.slice(next.length - MAX_TERMINAL_OUTPUT_BYTES)
}
