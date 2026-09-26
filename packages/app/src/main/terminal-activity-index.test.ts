import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TerminalActivityIndex } from './terminal-activity-index.js'

describe('TerminalActivityIndex', () => {
  it('persists terminal activity with readable output previews', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-terminal-activity-'))
    try {
      const workspaceA = join(dir, 'project-a')
      const workspaceB = join(dir, 'project-b')
      const index = new TerminalActivityIndex({ dataDir: dir })

      await index.append({
        command: 'pnpm test',
        cwd: workspaceA,
        workspacePath: workspaceA,
        sessionId: 's1',
        shell: 'Git Bash',
        startedAt: '2026-07-10T08:00:00.000Z',
        endedAt: '2026-07-10T08:00:02.000Z',
        durationMs: 2000,
        exitCode: null,
        signal: 'captured',
        timedOut: false,
        truncated: false,
        stdout: '\x1b[32mPASS\x1b[0m\n\x1b]0;PowerShell\x07done',
        stderr: '',
      })
      await index.append({
        command: 'echo other',
        cwd: workspaceB,
        workspacePath: workspaceB,
        startedAt: '2026-07-10T08:01:00.000Z',
        endedAt: '2026-07-10T08:01:01.000Z',
        durationMs: 1000,
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        stdout: 'other',
        stderr: '',
      })

      const reloaded = new TerminalActivityIndex({ dataDir: dir })
      const records = await reloaded.list({ workspacePath: workspaceA, sessionId: 's1' })

      expect(records).toHaveLength(1)
      expect(records[0]?.command).toBe('pnpm test')
      expect(records[0]?.signal).toBe('captured')
      expect(records[0]?.shell).toBe('Git Bash')
      expect(records[0]?.stdoutPreview).toBe('PASS\ndone')
      // The second record came from an Agent-run command with no session profile.
      const other = await reloaded.list({ workspacePath: workspaceB })
      expect(other[0]?.shell).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps records written before the Shell label existed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-terminal-activity-legacy-'))
    try {
      const workspace = join(dir, 'legacy-project')
      await mkdir(join(dir, 'workspace'), { recursive: true })
      await writeFile(join(dir, 'workspace', 'terminal-activity.json'), JSON.stringify({
        records: [{
          id: 'legacy-1',
          command: 'echo legacy',
          cwd: workspace,
          workspacePath: workspace,
          startedAt: '2026-07-01T08:00:00.000Z',
          endedAt: '2026-07-01T08:00:01.000Z',
          durationMs: 1000,
          exitCode: 0,
          signal: null,
          timedOut: false,
          truncated: false,
          stdoutPreview: 'legacy',
          stderrPreview: '',
        }],
      }), 'utf8')

      const records = await new TerminalActivityIndex({ dataDir: dir }).list({ workspacePath: workspace })
      expect(records.map((record) => record.command)).toEqual(['echo legacy'])
      expect(records[0]?.shell).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
