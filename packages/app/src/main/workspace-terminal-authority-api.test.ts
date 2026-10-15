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
const workspaceShellMocks = vi.hoisted(() => ({
  discoverWorkspaceShells: vi.fn(),
}))

vi.mock('./local-app-api/terminal-process.js', () => ({
  createWorkspaceTerminalProcess: terminalProcessMocks.createWorkspaceTerminalProcess,
}))
vi.mock('./workspace-shell-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace-shell-discovery.js')>()
  return {
    ...actual,
    discoverWorkspaceShells: workspaceShellMocks.discoverWorkspaceShells,
  }
})

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
    workspaceShellMocks.discoverWorkspaceShells.mockResolvedValue([
      {
        id: 'windows-powershell',
        kind: 'windows-powershell',
        label: 'Windows PowerShell',
        available: true,
        executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: [],
      },
      {
        id: 'missing-shell',
        kind: 'cmd',
        label: 'Unavailable shell',
        available: false,
        reason: 'not installed',
      },
    ])
  })

  it('bypasses Agent permission mode only for the user-owned interactive terminal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-workspace-terminal-authority-'))
    const workplaceDir = join(dataDir, 'workplace')
    mkdirSync(workplaceDir, { recursive: true })
    const config = structuredClone(DEFAULT_CONFIG)
    const runner = { state: { model: config.agents.defaults.model } } as unknown as AgentRunner
    const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
    await sessionIndex.upsert('research-session', {
      title: 'Research session',
      mode: 'research',
      scope: 'standalone',
      workspacePath: workplaceDir,
    })
    const developmentEnvironmentManager = {
      initialize: vi.fn(async () => undefined),
      terminalEnvironment: vi.fn(async () => process.env),
    } as unknown as DevelopmentEnvironmentManager
    const server = await startLocalAppApiServer({
    getRunner: () => runner,
      port: 0,
      sessionIndex,
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
          sessionId: 'research-session',
          // Renderer-supplied mode cannot replace Main's persisted session mode.
          permissionMode: 'full',
          approved: true,
        }),
      })
      expect(agentCommand.status).toBe(403)
      const streamedAgentCommand = await fetch(`${base}${LOCAL_APP_API_ROUTES.terminalStream}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root: workplaceDir,
          command: 'Write-Output blocked-agent-command',
          sessionId: 'research-session',
          permissionMode: 'full',
          approved: true,
        }),
      })
      expect(streamedAgentCommand.status).toBe(403)
      expect(terminalProcessMocks.createWorkspaceTerminalProcess).not.toHaveBeenCalled()

      await sessionIndex.upsert('full-access-session', {
        title: 'Full access session', mode: 'full-access', permissionVersion: 2,
        scope: 'standalone', workspacePath: workplaceDir,
      })
      const legacyFullAccessRoute = await fetch(`${base}${LOCAL_APP_API_ROUTES.terminalRun}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root: workplaceDir,
          command: 'Write-Output must-use-authorized-exec-tool',
          sessionId: 'full-access-session',
          approved: true,
          permissionMode: 'full',
        }),
      })
      expect(legacyFullAccessRoute.status).toBe(403)
      expect(terminalProcessMocks.createWorkspaceTerminalProcess).not.toHaveBeenCalled()

      // UX-29: the renderer asks for the shells this machine can run before it offers a picker.
      const shells = await fetch(`${base}${LOCAL_APP_API_ROUTES.terminalShells}`)
      expect(shells.status).toBe(200)
      const shellBody = await shells.json() as { shells?: Array<{ id: string; available: boolean; reason?: string }> }
      expect(Array.isArray(shellBody.shells)).toBe(true)
      expect(shellBody.shells!.length).toBeGreaterThan(0)
      for (const profile of shellBody.shells!) {
        // Every entry is either usable or explained; nothing is offered without a reason.
        if (!profile.available) expect(profile.reason, `${profile.id} needs a reason`).toBeTruthy()
      }
      expect(shellBody.shells!.some((profile) => profile.available)).toBe(true)

      const unknownShell = await fetch(`${base}${LOCAL_APP_API_ROUTES.terminalSession}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: workplaceDir, shellId: 'shell-that-does-not-exist' }),
      })
      expect(unknownShell.status).toBe(400)
      await expect(unknownShell.json()).resolves.toMatchObject({ error: expect.stringContaining('重新选择') })
      expect(terminalProcessMocks.createWorkspaceTerminalProcess).not.toHaveBeenCalled()

      const unavailableId = shellBody.shells!.find((profile) => !profile.available)?.id
      if (unavailableId) {
        const unavailableShell = await fetch(`${base}${LOCAL_APP_API_ROUTES.terminalSession}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: workplaceDir, shellId: unavailableId }),
        })
        expect(unavailableShell.status).toBe(400)
        expect(terminalProcessMocks.createWorkspaceTerminalProcess).not.toHaveBeenCalled()
      }

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
