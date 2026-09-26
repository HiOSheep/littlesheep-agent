// @littlesheep/app - workspace-shell-discovery.ts
// Discovers the shells the workspace terminal can actually run (UX-29).
//
// The contract is honesty: a profile exists for every shell the terminal knows about, and it
// says whether it is available and why not when it is not. Nothing is offered that would fail
// on start, and nothing is guessed from a name — `bash.exe` on Windows is usually the WSL
// stub in `System32`, so it only counts as Git Bash when it really lives inside a Git install.

import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type WorkspaceShellKind = 'windows-powershell' | 'powershell-7' | 'git-bash' | 'cmd' | 'wsl'

export interface WorkspaceShellProfile {
  /** Stable id the renderer sends back; Main validates it against a fresh discovery. */
  id: string
  kind: WorkspaceShellKind
  /** The name of the real shell, as the user should see it. */
  label: string
  available: boolean
  executable?: string
  args?: string[]
  env?: Record<string, string>
  distro?: string
  /** Why it cannot be used, when it cannot. */
  reason?: string
  /** What the user could install or configure, when there is something to do. */
  configHint?: string
}

export interface WorkspaceShellDiscoveryOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Injectable so every branch is testable without the matching machine. */
  fileExists?: (path: string) => boolean
  /** Lists WSL distributions; resolves to an empty list when WSL is unusable. */
  listWslDistributions?: () => Promise<string[]>
}

/** UTF-8 console bootstrap shared by both PowerShell editions. */
export function powershellArgs(): string[] {
  const bootstrap = [
    '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    'function global:prompt { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }',
  ].join('; ')
  return ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', bootstrap]
}

/** Git Bash starts as a login shell; it must never be handed PowerShell arguments. */
export function gitBashArgs(): string[] {
  return ['--login', '-i']
}

export function cmdArgs(): string[] {
  // A UTF-8 code page, so Chinese output survives the console.
  return ['/K', 'chcp 65001 >NUL']
}

/**
 * Map a Windows path to the path WSL sees.
 *
 * A WSL shell starts in a Linux directory, so the workspace root has to be translated
 * (`C:\Users\me\项目` → `/mnt/c/Users/me/项目`). A UNC path has no `/mnt` equivalent, so it
 * maps to nothing and the caller must fall back to the home directory rather than guess.
 */
export function windowsPathToWslPath(path: string): string | null {
  const normalized = path.trim().replace(/\\/gu, '/')
  if (normalized.startsWith('//')) return null
  const match = /^([A-Za-z]):(?:\/(.*))?$/u.exec(normalized)
  if (!match) return null
  const drive = match[1]!.toLowerCase()
  const rest = (match[2] ?? '').replace(/\/+$/u, '')
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`
}

/**
 * The arguments that start a WSL session in the workspace.
 *
 * Passing the mapped directory keeps the terminal where the user is working; without a
 * mapping (UNC workspace, or a path this cannot translate) it falls back to the home
 * directory instead of failing to start.
 */
export function wslArgs(distro: string, workspacePath?: string): string[] {
  const mapped = workspacePath ? windowsPathToWslPath(workspacePath) : null
  return ['-d', distro, '--cd', mapped ?? '~']
}

/**
 * Git for Windows keeps its bash inside its own installation.
 *
 * Anything else called `bash.exe` — `C:\Windows\System32\bash.exe` above all — is the WSL
 * launcher, and offering it as "Git Bash" would be a lie the user discovers on first use.
 */
export function isGitBashPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/').toLowerCase()
  if (!normalized.endsWith('/bash.exe')) return false
  if (normalized.includes('/windows/system32/')) return false
  return normalized.includes('/git/') && (normalized.includes('/bin/') || normalized.includes('/usr/bin/'))
}

/** The Git for Windows locations worth checking when bash is not on PATH. */
export function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env['ProgramFiles'],
    env['ProgramW6432'],
    env['ProgramFiles(x86)'],
    env['LOCALAPPDATA'] ? join(env['LOCALAPPDATA'], 'Programs') : undefined,
  ].filter((root): root is string => Boolean(root))
  const candidates = roots.flatMap((root) => [
    join(root, 'Git', 'bin', 'bash.exe'),
    join(root, 'Git', 'usr', 'bin', 'bash.exe'),
  ])
  // A Git Bash that is on PATH still has to prove it belongs to a Git installation.
  const pathEntries = (env['PATH'] ?? '').split(';').map((entry) => entry.trim()).filter(Boolean)
  for (const entry of pathEntries) {
    const candidate = join(entry, 'bash.exe')
    if (isGitBashPath(candidate)) candidates.push(candidate)
  }
  return candidates
}

function firstExisting(
  candidates: readonly string[],
  fileExists: (path: string) => boolean,
): string | undefined {
  return candidates.find((candidate) => fileExists(candidate))
}

/**
 * Read the WSL distribution list.
 *
 * `wsl.exe` writes UTF-16LE, so the output is decoded as such instead of being read as UTF-8
 * and arriving full of NUL bytes; an empty list is a valid answer, not an error.
 */
export async function listWslDistributionsReal(): Promise<string[]> {
  try {
    const { stdout } = await run('wsl.exe', ['--list', '--quiet'], {
      windowsHide: true,
      encoding: 'buffer',
      timeout: 5_000,
    })
    const text = Buffer.isBuffer(stdout)
      ? stdout.toString('utf16le')
      : String(stdout)
    return text
      .split(/\r?\n/u)
      .map((line) => line.replace(/\0/gu, '').trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

/**
 * Every shell the terminal can offer on this machine, available or not.
 *
 * Unavailable entries stay in the list with a reason, because a missing shell is information
 * the user needs, not something to hide.
 */
export async function discoverWorkspaceShells(
  options: WorkspaceShellDiscoveryOptions = {},
): Promise<WorkspaceShellProfile[]> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const fileExists = options.fileExists ?? ((path: string) => existsSync(path))
  const listWsl = options.listWslDistributions ?? listWslDistributionsReal

  if (platform !== 'win32') {
    const shell = env['SHELL'] || '/bin/sh'
    return [{
      id: 'posix-shell',
      kind: 'git-bash',
      label: shell.split('/').at(-1) ?? 'sh',
      available: fileExists(shell),
      executable: shell,
      args: ['-l'],
      ...(fileExists(shell)
        ? {}
        : { reason: `${shell} 不存在。`, configHint: '设置 SHELL 环境变量指向可用的 shell。' }),
    }]
  }

  const profiles: WorkspaceShellProfile[] = []

  const powershell7Candidates = [
    env['ProgramFiles'] ? join(env['ProgramFiles'], 'PowerShell', '7', 'pwsh.exe') : undefined,
    env['ProgramW6432'] ? join(env['ProgramW6432'], 'PowerShell', '7', 'pwsh.exe') : undefined,
  ].filter((path): path is string => Boolean(path))
  const powershell7 = firstExisting(powershell7Candidates, fileExists)
  profiles.push(powershell7
    ? {
      id: 'powershell-7',
      kind: 'powershell-7',
      label: 'PowerShell 7',
      available: true,
      executable: powershell7,
      args: powershellArgs(),
    }
    : {
      id: 'powershell-7',
      kind: 'powershell-7',
      label: 'PowerShell 7',
      available: false,
      reason: '未找到 pwsh.exe。',
      configHint: '安装 PowerShell 7（winget install Microsoft.PowerShell），或用 winget 的默认安装位置。',
    })

  const windowsPowerShell = env['SystemRoot']
    ? join(env['SystemRoot'], 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : undefined
  const windowsPowerShellPath = windowsPowerShell && fileExists(windowsPowerShell)
    ? windowsPowerShell
    : undefined
  profiles.push(windowsPowerShellPath
    ? {
      id: 'windows-powershell',
      kind: 'windows-powershell',
      label: 'Windows PowerShell',
      available: true,
      executable: windowsPowerShellPath,
      args: powershellArgs(),
    }
    : {
      id: 'windows-powershell',
      kind: 'windows-powershell',
      label: 'Windows PowerShell',
      available: false,
      reason: '未找到 System32 下的 Windows PowerShell。',
      configHint: '该系统缺少 Windows PowerShell 5.1，通常需要修复 Windows 组件。',
    })

  const gitBash = firstExisting(gitBashCandidates(env), fileExists)
  profiles.push(gitBash
    ? {
      id: 'git-bash',
      kind: 'git-bash',
      label: 'Git Bash',
      available: true,
      executable: gitBash,
      args: gitBashArgs(),
      env: { LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    }
    : {
      id: 'git-bash',
      kind: 'git-bash',
      label: 'Git Bash',
      available: false,
      reason: '未找到属于 Git for Windows 的 bash.exe（System32 下的 bash.exe 是 WSL 启动器，不算 Git Bash）。',
      configHint: '安装 Git for Windows（winget install Git.Git），或确认安装在默认目录。',
    })

  const cmd = env['SystemRoot'] ? join(env['SystemRoot'], 'System32', 'cmd.exe') : undefined
  const cmdPath = cmd && fileExists(cmd) ? cmd : undefined
  profiles.push(cmdPath
    ? { id: 'cmd', kind: 'cmd', label: '命令提示符', available: true, executable: cmdPath, args: cmdArgs() }
    : {
      id: 'cmd',
      kind: 'cmd',
      label: '命令提示符',
      available: false,
      reason: '未找到 System32 下的 cmd.exe。',
      configHint: '该系统缺少命令提示符，通常需要修复 Windows 组件。',
    })

  const distros = await listWsl()
  if (distros.length === 0) {
    profiles.push({
      id: 'wsl',
      kind: 'wsl',
      label: 'WSL Bash',
      available: false,
      reason: 'WSL 不可用或没有已安装的发行版。',
      configHint: '安装发行版：wsl --install -d <发行版>，然后用 wsl --list --quiet 确认。',
    })
  } else {
    for (const distro of distros) {
      profiles.push({
        id: `wsl:${distro}`,
        kind: 'wsl',
        label: `WSL · ${distro}`,
        available: true,
        executable: 'wsl.exe',
        args: wslArgs(distro),
        distro,
        env: { LANG: 'C.UTF-8', TERM: 'xterm-256color' },
      })
    }
  }

  return profiles
}

/** The profile for an id the renderer sent back, or null when it is not on offer. */
export function findWorkspaceShellProfile(
  profiles: readonly WorkspaceShellProfile[],
  id: unknown,
): WorkspaceShellProfile | null {
  if (typeof id !== 'string') return null
  const profile = profiles.find((candidate) => candidate.id === id && candidate.available)
  return profile ?? null
}

/** The default shell: PowerShell 7 when present, then Windows PowerShell, then cmd. */
export function defaultWorkspaceShellProfile(
  profiles: readonly WorkspaceShellProfile[],
): WorkspaceShellProfile | null {
  for (const id of ['windows-powershell', 'powershell-7', 'cmd', 'git-bash']) {
    const profile = findWorkspaceShellProfile(profiles, id)
    if (profile) return profile
  }
  return profiles.find((profile) => profile.available) ?? null
}
