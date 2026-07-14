// Resolve and launch VS Code without coupling workspace routes to process details.

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
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
  for (const candidate of vscodeCommandCandidates()) {
    if (candidate === 'code' || candidate === 'code.cmd') return candidate
    if (await pathExists(candidate)) return candidate
  }
  throw new HttpError(501, '未找到 VS Code。请先安装 VS Code，或把 code 命令加入 PATH。')
}

function vscodeCommandCandidates(): string[] {
  if (process.platform !== 'win32') return ['code']
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const programFiles = process.env.ProgramFiles ?? ''
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? ''
  return [
    localAppData && resolve(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    programFiles && resolve(programFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
    programFilesX86 && resolve(programFilesX86, 'Microsoft VS Code', 'bin', 'code.cmd'),
    'code.cmd',
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
