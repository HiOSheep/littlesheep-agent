// Bounded non-interactive workspace command execution.

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { HttpError } from './http.js'

export const MAX_TERMINAL_COMMAND_BYTES = 16 * 1024
export const MAX_TERMINAL_OUTPUT_BYTES = 512 * 1024
const DEFAULT_TERMINAL_TIMEOUT_MS = 120_000
const MAX_TERMINAL_TIMEOUT_MS = 300_000

export interface WorkspaceTerminalCommandEvents {
  onStart?: (cancel: () => void) => void
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
  onTruncated?: () => void
}

export function clampTerminalTimeout(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TERMINAL_TIMEOUT_MS
  return Math.max(1_000, Math.min(MAX_TERMINAL_TIMEOUT_MS, Math.round(requested)))
}

export async function runWorkspaceTerminalCommand(
  root: string,
  command: string,
  timeoutMs: number,
  events: WorkspaceTerminalCommandEvents = {},
) {
  if (Buffer.byteLength(command, 'utf8') > MAX_TERMINAL_COMMAND_BYTES) {
    throw new HttpError(413, `命令超过 ${Math.round(MAX_TERMINAL_COMMAND_BYTES / 1024)} KB。`)
  }
  if (command.includes('\u0000')) throw new HttpError(400, 'command contains invalid characters')
  const info = await stat(root)
  if (!info.isDirectory()) throw new HttpError(400, 'workspace root is not a directory')
  const shellCommand = process.platform === 'win32'
    ? (process.env.ComSpec && process.env.ComSpec.toLowerCase().endsWith('powershell.exe') ? process.env.ComSpec : 'powershell.exe')
    : (process.env.SHELL || '/bin/sh')
  const normalizedCommand = process.platform === 'win32'
    ? `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${command}`
    : command
  const encodedCommand = process.platform === 'win32'
    ? Buffer.from(normalizedCommand, 'utf16le').toString('base64')
    : ''
  const shellArgs = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand]
    : ['-lc', normalizedCommand]
  const startedAt = performance.now()

  return new Promise<{
    command: string
    cwd: string
    exitCode: number | null
    signal: string | null
    stdout: string
    stderr: string
    durationMs: number
    timedOut: boolean
    truncated: boolean
  }>((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let truncated = false
    let truncationNotified = false
    let timedOut = false

    const notifyTruncated = () => {
      truncated = true
      if (truncationNotified) return
      truncationNotified = true
      events.onTruncated?.()
    }
    const appendOutput = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = MAX_TERMINAL_OUTPUT_BYTES - outputBytes
      if (remaining <= 0) {
        notifyTruncated()
        return
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      const text = slice.toString('utf8')
      if (target === 'stdout') {
        stdout += text
        events.onStdout?.(text)
      } else {
        stderr += text
        events.onStderr?.(text)
      }
      outputBytes += slice.length
      if (slice.length < chunk.length) notifyTruncated()
    }
    const child = spawn(shellCommand, shellArgs, {
      cwd: root,
      env: process.env,
      windowsHide: true,
    })
    events.onStart?.(() => {
      if (!child.killed) child.kill()
    })
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => appendOutput('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => appendOutput('stderr', chunk))
    child.once('error', (error) => {
      clearTimeout(timeout)
      const message = stderr ? `\n${error.message}` : error.message
      stderr += message
      events.onStderr?.(message)
      resolvePromise({
        command,
        cwd: root,
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
        timedOut,
        truncated,
      })
    })
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout)
      if (timedOut) {
        const message = `\n命令超过 ${Math.round(timeoutMs / 1000)} 秒，已停止。`
        stderr += stderr ? message : message.trimStart()
        events.onStderr?.(message)
      }
      resolvePromise({
        command,
        cwd: root,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
        timedOut,
        truncated,
      })
    })
  })
}
