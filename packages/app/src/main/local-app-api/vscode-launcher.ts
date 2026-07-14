// Resolve and launch VS Code without coupling workspace routes to process details.

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { HttpError } from './http.js'

export async function openInVSCode(target: string): Promise<void> {
  const command = await resolveVSCodeCommand()
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const args = ['--reuse-window', target]
    const child = process.platform === 'win32'
      ? spawn([quoteWindowsShellArg(command), ...args.map(quoteWindowsShellArg)].join(' '), {
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      : spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', (error) => {
      rejectPromise(new HttpError(500, `无法启动 VS Code：${error.message}`))
    })
    child.once('exit', (code) => {
      if (code === 0 || code === null) {
        resolvePromise()
        return
      }
      rejectPromise(new HttpError(500, '无法启动 VS Code。请确认已安装 VS Code，并且 code 命令可用。'))
    })
    child.unref()
  })
}

async function resolveVSCodeCommand(): Promise<string> {
  const candidates = vscodeCommandCandidates()
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue
    if (await pathExists(candidate)) return candidate
  }
  return 'code'
}

function vscodeCommandCandidates(): string[] {
  if (process.platform !== 'win32') return ['/usr/local/bin/code', '/opt/homebrew/bin/code', 'code']
  return [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd') : '',
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Microsoft VS Code', 'bin', 'code.cmd') : '',
    process.env['PROGRAMFILES(X86)'] ? join(process.env['PROGRAMFILES(X86)'], 'Microsoft VS Code', 'bin', 'code.cmd') : '',
    'code',
  ].filter(Boolean)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function quoteWindowsShellArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}
