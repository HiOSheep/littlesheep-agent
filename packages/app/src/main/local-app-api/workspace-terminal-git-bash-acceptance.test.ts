// UX-32: exercise the discovered Git Bash through the real terminal session manager.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverWorkspaceShells } from '../workspace-shell-discovery'
import { WorkspaceTerminalSessionManager } from './terminal-session'

const managers: WorkspaceTerminalSessionManager[] = []
const roots: string[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.closeAll()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
})

function plain(value: string): string {
  return value.replace(/\u001B\][^\u0007]*\u0007/gu, '')
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/gu, '').replace(/\r/gu, '\n')
}

describe('workspace terminal Git Bash acceptance', () => {
  it('runs Bash in a Chinese and spaced workspace with UTF-8 and multiline input', async () => {
    const profile = (await discoverWorkspaceShells()).find((entry) => entry.id === 'git-bash')
    if (!profile?.available) return
    expect(profile.args).toEqual(['--login', '-i'])

    const base = await mkdtemp(join(tmpdir(), 'ls-git-bash-'))
    roots.push(base)
    const root = join(base, '中文 工作区')
    await mkdir(root)
    const manager = new WorkspaceTerminalSessionManager()
    managers.push(manager)
    const session = await manager.create(root, { cols: 120, rows: 40 }, { ...process.env }, profile)
    let output = ''
    session.on('stdout', (chunk: string) => { output += chunk })
    session.on('stderr', (chunk: string) => { output += chunk })
    const waitFor = async (marker: string) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const match = plain(output).match(new RegExp(`^${marker}:(.*)$`, 'mu'))
        if (match) return match[1]!.trim()
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`Git Bash did not print ${marker}: ${plain(output).slice(-500)}`)
    }

    // Split markers across format arguments so the echoed input cannot satisfy a probe.
    session.writeInput("printf 'LS-%s:%s\\n' BASH \"$BASH_VERSION\"\n")
    expect(await waitFor('LS-BASH')).toMatch(/^\d+\.\d+/u)
    session.writeInput("printf 'LS-%s:%s\\n' CWD \"$(cygpath -w \"$PWD\")\"\n")
    expect((await waitFor('LS-CWD')).toLowerCase()).toBe(root.toLowerCase())
    session.writeInput("printf 'LS-%s:%s\\n' LANG \"$LANG\"; printf 'LS-%s:%s\\n' TERM \"$TERM\"\n")
    expect(await waitFor('LS-LANG')).toBe('C.UTF-8')
    expect(await waitFor('LS-TERM')).toBe('xterm-256color')
    session.writeInput("printf 'LS-%s:%s\\n' CN 中文输出\nprintf 'LS-%s:%s\\n' PASTE 第二行\n")
    expect(await waitFor('LS-CN')).toBe('中文输出')
    expect(await waitFor('LS-PASTE')).toBe('第二行')
  }, 90_000)
})
