import { describe, expect, it } from 'vitest'
import { workspaceShellConfig } from './workspace-shell.js'

describe('workspaceShellConfig', () => {
  it('uses an in-app PowerShell session on Windows', () => {
    const config = workspaceShellConfig('win32', {})

    expect(config.command).toBe('powershell.exe')
    expect(config.label).toBe('PowerShell')
    expect(config.args).toEqual(expect.arrayContaining(['-NoLogo', '-NoProfile', '-NoExit']))
    expect(config.args.join(' ')).toContain('InputEncoding')
    expect(config.args.join(' ')).toContain('OutputEncoding')
  })

  it('uses the login shell on non-Windows systems', () => {
    const config = workspaceShellConfig('linux', { SHELL: '/usr/bin/zsh' })

    expect(config.command).toBe('/usr/bin/zsh')
    expect(config.args).toEqual(['-l'])
    expect(config.label).toBe('zsh')
  })
})
