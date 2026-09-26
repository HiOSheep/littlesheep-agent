// UX-29 item 4: acceptance against the shell that is really running.
//
// The session is the real one the app creates — the same discovery, the same launch, the same
// stream — so these assertions describe what a user gets, not a mock of it.
//
// Markers are built at run time ("LS-" + "MAJOR:") because a terminal echoes the command it is
// given: a literal marker would match the echo before any output existed.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceTerminalSessionManager } from './terminal-session'
import { discoverWorkspaceShells, type WorkspaceShellProfile } from '../workspace-shell-discovery'

const cleanup: string[] = []
const managers: WorkspaceTerminalSessionManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.closeAll()
  while (cleanup.length > 0) {
    const directory = cleanup.pop()
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
})

/** Terminal output carries cursor and colour escapes; the assertions are about text. */
function plainText(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*\u0007/gu, '')
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    .replace(/\r/gu, '\n')
}

/** A command whose output marker cannot be confused with the echoed command. */
function probe(name: string, expression: string): string {
  return `Write-Output ("LS-" + "${name}:" + ${expression})\r`
}

interface SessionHarness {
  write: (data: string) => void
  /** Waits for a marker the command itself prints, so no sleep guessing is involved. */
  waitFor: (needle: string, timeoutMs?: number) => Promise<string>
  close: () => void
}

async function startPowerShellSession(profile: WorkspaceShellProfile, root: string): Promise<SessionHarness> {
  const manager = new WorkspaceTerminalSessionManager()
  managers.push(manager)
  const session = await manager.create(root, { cols: 120, rows: 40 }, { ...process.env }, profile)
  let buffer = ''
  session.on('stdout', (text: string) => { buffer += text })
  session.on('stderr', (text: string) => { buffer += text })
  return {
    write: (data) => session.writeInput(data),
    waitFor: async (needle, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const text = plainText(buffer)
        const index = text.indexOf(needle)
        if (index >= 0) return text.slice(index, index + 600)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`terminal never printed ${JSON.stringify(needle)}; saw: ${plainText(buffer).slice(-600)}`)
    },
    close: () => session.kill(),
  }
}

async function powershellProfile(): Promise<WorkspaceShellProfile | undefined> {
  const profiles = await discoverWorkspaceShells()
  return profiles.find((candidate) => candidate.id === 'powershell-7' && candidate.available)
    ?? profiles.find((candidate) => candidate.id === 'windows-powershell' && candidate.available)
}

describe('workspace terminal shell acceptance', () => {
  it('runs the discovered PowerShell and proves which one it is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-terminal-acceptance-'))
    cleanup.push(root)
    const profile = await powershellProfile()
    expect(profile, 'this machine has no PowerShell to accept against').toBeTruthy()

    const session = await startPowerShellSession(profile!, root)
    try {
      // The version has to match the shell that was actually launched: PowerShell 7 reports
      // major 7+, Windows PowerShell reports 5.
      session.write(probe('MAJOR', '$PSVersionTable.PSVersion.Major'))
      const version = await session.waitFor('LS-MAJOR:')
      const major = Number(/LS-MAJOR:(\d+)/u.exec(version)?.[1] ?? 0)
      expect(major).toBeGreaterThanOrEqual(profile!.id === 'powershell-7' ? 7 : 5)
      if (profile!.id === 'windows-powershell') expect(major).toBe(5)

      // Real process information: the executable behind this session is the discovered one.
      session.write(probe('EXE', '(Get-Process -Id $PID).Path'))
      const executable = await session.waitFor('LS-EXE:')
      expect(executable.toLowerCase()).toContain(profile!.id === 'powershell-7' ? 'pwsh.exe' : 'powershell.exe')

      // The session starts in the workspace root, and Chinese survives the round trip.
      session.write(probe('CWD', '(Get-Location).Path'))
      const cwd = await session.waitFor('LS-CWD:')
      expect(cwd.toLowerCase()).toContain(root.toLowerCase())

      session.write(probe('CN', '"中文输出-测试"'))
      expect(await session.waitFor('LS-CN:')).toContain('LS-CN:中文输出-测试')

      session.write(probe('ENV', '($env:PATH.Length -gt 0)'))
      expect(await session.waitFor('LS-ENV:')).toContain('LS-ENV:True')
    } finally {
      session.close()
    }
  }, 120_000)

  it('accepts a pasted block and keeps the session usable afterwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-terminal-paste-'))
    cleanup.push(root)
    const profile = await powershellProfile()
    if (!profile) return

    const session = await startPowerShellSession(profile, root)
    try {
      // A two-line paste: both lines must run, in order, from one write.
      session.write(probe('LINE-1', '"one"') + probe('LINE-2', '"two"'))
      const both = await session.waitFor('LS-LINE-2:')
      expect(both).toContain('LS-LINE-2:two')

      // A common development command still works after the paste.
      session.write(probe('AFTER', '(1 + 1)'))
      expect(await session.waitFor('LS-AFTER:')).toContain('LS-AFTER:2')
    } finally {
      session.close()
    }
  }, 120_000)

  it('fails loudly when a discovered shell cannot start, instead of hanging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-terminal-broken-'))
    cleanup.push(root)
    // A profile that passed discovery and then disappeared is exactly the "startup failed"
    // case the menu has to recover from; the error has to reach the caller.
    const broken: WorkspaceShellProfile = {
      id: 'windows-powershell',
      kind: 'windows-powershell',
      label: 'Windows PowerShell',
      available: true,
      executable: join(root, 'definitely-not-a-shell.exe'),
      args: [],
    }
    const manager = new WorkspaceTerminalSessionManager()
    managers.push(manager)

    await expect(manager.create(root, { cols: 80, rows: 24 }, { ...process.env }, broken))
      .rejects.toThrow()
  }, 60_000)
})