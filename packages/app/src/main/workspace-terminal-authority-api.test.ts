import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { LOCAL_APP_API_PREFIXES, LOCAL_APP_API_ROUTES, localAppApiItemPath } from '../shared/local-app-api-routes.js'
import { ArchiveIndex } from './archive-index.js'
import type { DevelopmentEnvironmentManager } from './development-environments.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'

const terminalProcessMocks = vi.hoisted(() => ({
  createWorkspaceTerminalProcess: vi.fn(),
  writes: [] as string[],
}))

vi.mock('./local-app-api/terminal-process.js', () => ({
  createWorkspaceTerminalProcess: terminalProcessMocks.createWorkspaceTerminalProcess,
}))

import { startLocalAppApiServer } from './local-app-api-server.js'

describe('workspace terminal authority API', () => {
  beforeEach(() => {
    terminalProcessMocks.writes.length = 0
    terminalProcessMocks.createWorkspaceTerminalProcess.mockReset()
    terminalProcessMocks.createWorkspaceTerminalProcess.mockImplementation(async () => ({
      kind: 'pty' as const,
      label: 'Test PTY',
      write: (data: string) => terminalProcessMocks.writes.push(data),
      resize: vi.fn(),
      interrupt: vi.fn(),
      kill: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
      onError: vi.fn(() => () => undefined),
    }))
  })

  it('bypasses Agent permission mode only for the user-owned interactive terminal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-workspace-terminal-authority-'))
    const workplaceDir = join(dataDir, 'workplace')
    mkdirSync(workplaceDir, { recursive: true })
    const config = structuredClone(DEFAULT_CONFIG)
    const runner = { state: { model: config.agents.defaults.model } } as unknown as AgentRunner
    const developmentEnvironmentManager = {
      initialize: vi.fn(async () => undefined),
      terminalEnvironment: vi.fn(async () => process.env),
    } as unknown as DevelopmentEnvironmentManager
    const server = await startLocalAppApiServer({
    getRunner: () => runner,
      port: 0,
      sessionIndex: new SessionIndex({ dataDir, workplaceDir }),
      projectIndex: new ProjectIndex({ dataDir }),
      archiveIndex: new ArchiveIndex({ dataDir, workplaceDir }),
      terminalActivityIndex: new TerminalActivityIndex({ dataDir }),
      workspaceArtifactIndex: new WorkspaceArtifactIndex({ dataDir }),
      workspaceLayoutIndex: new WorkspaceLayoutIndex({ dataDir }),
      config,
      dataDir,
      workplaceDir,
      developmentEnvironmentManager,
      rebuildRunner: vi.fn(async () => undefined),
      updateRuntimeConfig: vi.fn(async () => undefined),
    })
    await server.setRunner(runner)

    try {
      const base = `http://127.0.0.1:${server.port}`
      const agentCommand = await fetch(`${base}${LOCAL_APP_API_ROUTES.terminalRun}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root: workplaceDir,
          command: 'Write-Output blocked-agent-command',
          permissionMode: 'research',
          approved: false,
        }),
      })
      expect(agentCommand.status).toBe(403)

      const created = await fetch(`${base}${LOCAL_APP_API_ROUTES.terminalSession}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root: workplaceDir,
          permissionMode: 'restricted',
          approved: false,
        }),
      })
      expect(created.status).toBe(200)
      const session = await created.json() as { sessionId: string; source: string }
      expect(session.source).toBe('workspace-user')

      const inputPath = localAppApiItemPath(
        LOCAL_APP_API_PREFIXES.terminalSessions,
        session.sessionId,
        '/input',
      )
      const input = await fetch(`${base}${inputPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: 'Get-Date\r',
          sessionId: 'conversation-1',
          permissionMode: 'restricted',
          approved: false,
        }),
      })
      expect(input.status).toBe(200)
      await expect(input.json()).resolves.toEqual({ ok: true, completed: 1 })
      expect(terminalProcessMocks.writes).toEqual(['Get-Date\r'])

      const closed = await fetch(`${base}${localAppApiItemPath(
        LOCAL_APP_API_PREFIXES.terminalSessions,
        session.sessionId,
      )}`, { method: 'DELETE' })
      expect(closed.status).toBe(204)
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
