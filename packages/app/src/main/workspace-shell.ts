// @littlesheep/app - workspace-shell.ts
// Shell selection for the LS-owned workspace terminal.

import { basename } from 'node:path'

export interface WorkspaceShellConfig {
  command: string
  args: string[]
  label: string
}

export function workspaceShellConfig(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceShellConfig {
  if (platform === 'win32') {
    const bootstrap = [
      '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$OutputEncoding = [Console]::OutputEncoding',
      'function global:prompt { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }',
    ].join('; ')
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', bootstrap],
      label: 'PowerShell',
    }
  }

  const shell = env.SHELL || '/bin/sh'
  return {
    command: shell,
    args: ['-l'],
    label: basename(shell),
  }
}
