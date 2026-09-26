// UX-29: a saved Shell preference that no longer exists must be reported, not silently
// replaced, and the session label must be the real shell rather than a hardcoded name.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { WorkspaceShellProfile } from '../api/terminal'
import {
  defaultTerminalShell,
  resolveTerminalShellChoice,
  terminalShellLabel,
} from './terminal-shell-choice'

const profile = (
  id: string,
  label: string,
  available = true,
  extra: Partial<WorkspaceShellProfile> = {},
): WorkspaceShellProfile => ({ id, kind: 'cmd', label, available, ...extra })

const MACHINE: WorkspaceShellProfile[] = [
  profile('powershell-7', 'PowerShell 7', true),
  profile('windows-powershell', 'Windows PowerShell', true),
  profile('git-bash', 'Git Bash', false, {
    reason: '未找到属于 Git for Windows 的 bash.exe。',
    configHint: '安装 Git for Windows。',
  }),
  profile('wsl:Ubuntu', 'WSL · Ubuntu', true, { distro: 'Ubuntu' }),
]

describe('terminal shell choice', () => {
  it('runs the saved preference when it is still available', () => {
    const choice = resolveTerminalShellChoice(MACHINE, 'wsl:Ubuntu')
    expect(choice.selected?.id).toBe('wsl:Ubuntu')
    expect(choice.notice).toBeNull()
    expect(choice.preferenceLost).toBe(false)
  })

  it('explains a preference that disappeared and names the replacement', () => {
    const choice = resolveTerminalShellChoice(MACHINE, 'git-bash')
    // Windows PowerShell stays the default so an existing session migrates unchanged.
    expect(choice.selected?.id).toBe('windows-powershell')
    expect(choice.preferenceLost).toBe(true)
    expect(choice.notice).toContain('Git for Windows')
    expect(choice.notice).toContain('已改用 Windows PowerShell')
  })

  it('treats an id it has never heard of the same way', () => {
    const choice = resolveTerminalShellChoice(MACHINE, 'rm -rf /')
    expect(choice.preferenceLost).toBe(true)
    expect(choice.notice).toContain('不在本机可用列表中')
    expect(choice.selected?.id).toBe('windows-powershell')
  })

  it('falls back in order and admits when nothing is available', () => {
    expect(defaultTerminalShell(MACHINE)?.id).toBe('windows-powershell')
    expect(defaultTerminalShell([profile('git-bash', 'Git Bash', true)])?.id).toBe('git-bash')
    const nothing = resolveTerminalShellChoice([profile('cmd', '命令提示符', false, { reason: '缺失。' })], 'cmd')
    expect(nothing.selected).toBeNull()
    expect(nothing.notice).toContain('当前没有可用的 Shell')
  })

  it('labels a session with the shell that is really running', () => {
    expect(terminalShellLabel(MACHINE, 'git-bash', 'Git Bash PTY')).toBe('Git Bash PTY')
    expect(terminalShellLabel(MACHINE, 'wsl:Ubuntu')).toBe('WSL · Ubuntu')
    expect(terminalShellLabel(MACHINE, 'gone')).toBe('Shell')
  })

  it('is what the terminal surface renders', async () => {
    const terminal = await readFile(new URL('./terminal.tsx', import.meta.url), 'utf8')
    const picker = await readFile(new URL('./terminal-shell-picker.tsx', import.meta.url), 'utf8')
    expect(terminal).toContain('WorkspaceTerminalShellPicker')
    expect(terminal).toContain('resolveTerminalShellChoice')
    expect(picker).toContain('aria-label="选择终端 Shell"')
    expect(picker).toContain('本机缺少')
  })
})
