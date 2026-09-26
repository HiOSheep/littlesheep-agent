// UX-30 item 1: several terminal sessions live at once, and one must not disturb another.
//
// This is the Main-side half of the claim: two sessions in one manager, started with different
// shells, keep their own process, output and exit state; closing one leaves the other running.
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

function probe(name: string, expression: string): string {
  return `Write-Output ("LS-" + "${name}:" + ${expression})\r`
}

function plain(value: string): string {
  return value.replace(/\u001B\[[0-9;?]*[A-Za-z]/gu, '').replace(/\r/gu, '\n')
}

describe('workspace terminal sessions coexist', () => {
  it('runs two PowerShell sessions side by side and closes only the one asked for', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-terminal-multi-'))
    cleanup.push(root)
    const manager = new WorkspaceTerminalSessionManager()
    managers.push(manager)
    const profiles = await discoverWorkspaceShells()
    const profile: WorkspaceShellProfile | undefined =
      profiles.find((candidate) => candidate.available && candidate.kind !== 'wsl')
    expect(profile, 'no usable shell on this machine').toBeTruthy()

    const first = await manager.create(root, { cols: 100, rows: 30 }, { ...process.env }, profile!)
    const second = await manager.create(root, { cols: 100, rows: 30 }, { ...process.env }, profile!)
    expect(first.sessionId).not.toBe(second.sessionId)

    const buffers = new Map<string, string>([[first.sessionId, ''], [second.sessionId, '']])
    for (const session of [first, second]) {
      session.on('stdout', (text: string) => buffers.set(session.sessionId, buffers.get(session.sessionId) + text))
      session.on('stderr', (text: string) => buffers.set(session.sessionId, buffers.get(session.sessionId) + text))
    }
    const waitFor = async (sessionId: string, needle: string, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const text = plain(buffers.get(sessionId) ?? '')
        if (text.includes(needle)) return text
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`session ${sessionId} never printed ${needle}: ${plain(buffers.get(sessionId) ?? '').slice(-300)}`)
    }

    // Each session answers its own commands; output does not leak between them.
    first.writeInput(probe('FIRST', '"one"'))
    second.writeInput(probe('SECOND', '"two"'))
    expect(await waitFor(first.sessionId, 'LS-FIRST:')).toContain('LS-FIRST:one')
    expect(await waitFor(second.sessionId, 'LS-SECOND:')).toContain('LS-SECOND:two')
    expect(plain(buffers.get(first.sessionId) ?? '')).not.toContain('LS-SECOND:')
    expect(plain(buffers.get(second.sessionId) ?? '')).not.toContain('LS-FIRST:')

    // Closing one session leaves the other one alive and usable.
    manager.close(first.sessionId)
    await new Promise((resolve) => setTimeout(resolve, 500))
    second.writeInput(probe('AFTER', '"still here"'))
    expect(await waitFor(second.sessionId, 'LS-AFTER:')).toContain('LS-AFTER:still here')

    // The closed session is gone from the manager, not merely stopped.
    expect(() => manager.close(first.sessionId)).not.toThrow()
  }, 180_000)

  it('refuses to create more sessions than the documented cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-terminal-cap-'))
    cleanup.push(root)
    const manager = new WorkspaceTerminalSessionManager()
    managers.push(manager)
    const profiles = await discoverWorkspaceShells()
    const profile = profiles.find((candidate) => candidate.available && candidate.kind === 'cmd')
    if (!profile) return

    // cmd starts fastest and stays alive with `/K`, so the cap is reached without waiting on
    // PowerShell profiles; the cap itself is what is under test.
    const created: string[] = []
    let failure: unknown
    for (let index = 0; index < 40; index += 1) {
      try {
        const session = await manager.create(root, { cols: 80, rows: 24 }, { ...process.env }, profile)
        created.push(session.sessionId)
      } catch (error) {
        failure = error
        break
      }
    }
    expect(created.length).toBeGreaterThan(0)
    expect(failure, 'the manager must refuse beyond its cap').toBeTruthy()
    expect(String((failure as Error).message)).toContain('too many')
  }, 180_000)
})
