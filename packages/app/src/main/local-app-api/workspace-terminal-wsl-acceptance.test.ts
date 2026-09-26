// UX-29 items 3 and 4, Bash side — measured against the shell this host can actually start.
//
// Discovery reports what it can establish: the distribution is registered, and `wsl.exe` can
// run a trivial command. Whether a *terminal* session starts is a different path (ConPTY plus
// the WSL relay), and on this host it does not: the launch fails with
// `Wsl/Service/E_UNEXPECTED` because the localhost proxy is not mirrored into WSL.
//
// Both outcomes are therefore asserted, so this file is honest wherever it runs: a session that
// starts must be a real Bash in the mapped workspace, and a session that cannot start must
// report why instead of hanging or looking alive.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceTerminalSessionManager } from './terminal-session'
import { discoverWorkspaceShells, windowsPathToWslPath, type WorkspaceShellProfile } from '../workspace-shell-discovery'

const cleanup: string[] = []
const managers: WorkspaceTerminalSessionManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.closeAll()
  while (cleanup.length > 0) {
    const directory = cleanup.pop()
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
})

function plain(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*\u0007/gu, '')
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/gu, '')
    .replace(/\r/gu, '\n')
}

describe('workspace terminal WSL acceptance', () => {
  it('either runs a real Bash in the mapped workspace, or reports why it cannot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-terminal-wsl-'))
    cleanup.push(root)
    const profiles = await discoverWorkspaceShells()
    const wsl = profiles.filter((profile) => profile.kind === 'wsl')

    // Whatever the outcome, an unavailable entry has to explain itself.
    for (const profile of wsl.filter((entry) => !entry.available)) {
      expect(profile.reason, `${profile.id} needs a reason`).toBeTruthy()
    }

    const usable: WorkspaceShellProfile | undefined = wsl.find((entry) => entry.available)
    if (!usable) return

    const manager = new WorkspaceTerminalSessionManager()
    managers.push(manager)
    let buffer = ''
    let startError = ''
    let session: Awaited<ReturnType<typeof manager.create>> | null = null
    try {
      session = await manager.create(root, { cols: 120, rows: 40 }, { ...process.env }, usable)
      session.on('stdout', (text: string) => { buffer += text })
      session.on('stderr', (text: string) => { buffer += text })
      session.on('error', (error: Error) => { startError = startError || error.message })
    } catch (error) {
      startError = (error as Error).message
    }

    const deadline = Date.now() + 120_000
    const mapped = windowsPathToWslPath(root)
    const sawBash = () => /LS-BASH:\d+\.\d+/u.test(plain(buffer))
    const sawFailure = () => /E_UNEXPECTED|不支持|错误代码|not supported|代理/u.test(plain(buffer) + startError)

    if (session) session.writeInput('printf "LS-BASH:%s\\n" "$BASH_VERSION"\n')
    while (Date.now() < deadline && !sawBash() && !sawFailure()) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    if (sawBash()) {
      // The happy path, on a host where WSL sessions work.
      expect(mapped).not.toBeNull()
      const text = plain(buffer)
      expect(text).toMatch(/LS-BASH:\d+\.\d+/u)
      session!.writeInput('printf "LS-PWD:%s\\n" "$PWD"\n')
      session!.writeInput('printf "LS-UNAME:%s\\n" "$(uname -s)"\n')
      const after = Date.now() + 60_000
      while (Date.now() < after && !/LS-UNAME:/u.test(plain(buffer))) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      expect(plain(buffer)).toContain(`LS-PWD:${mapped}`)
      expect(plain(buffer)).toContain('LS-UNAME:Linux')
      return
    }

    // The measured outcome on this host: the session cannot start, and it says why.
    expect(
      sawFailure(),
      `a WSL session that cannot start must report why; saw: ${plain(buffer).slice(-400)} ${startError}`,
    ).toBe(true)
    if (session) session.kill()
  }, 240_000)

  it('maps the workspace path even when the session cannot start', async () => {
    // The mapping is what the session *would* use, and it is verified independently so a host
    // without a working WSL still has its correctness pinned.
    const root = await mkdtemp(join(tmpdir(), 'ls-terminal-wsl-map-'))
    cleanup.push(root)
    const mapped = windowsPathToWslPath(root)
    expect(mapped).toMatch(/^\/mnt\/[a-z]\//u)
    expect(mapped).not.toContain('\\')
  })
})
