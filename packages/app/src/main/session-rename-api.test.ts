import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { asSessionId } from '@littlesheep/types'
import {
  LOCAL_APP_API_PREFIXES,
  localAppApiItemPath,
} from '../shared/local-app-api-routes.js'
import { ArchiveIndex } from './archive-index.js'
import { startLocalAppApiServer } from './local-app-api-server.js'
import { ProjectIndex } from './project-index.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'

describe('session rename Local App API', () => {
  it('persists standalone and project titles without changing activity metadata', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-session-rename-api-'))
    const workplaceDir = join(dataDir, 'workplace')
    mkdirSync(workplaceDir, { recursive: true })
    const config = structuredClone(DEFAULT_CONFIG)
    const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
    await sessionIndex.upsert('standalone', {
      title: 'Standalone',
      createdAt: 1,
      lastMessageAt: 10,
      mode: 'research',
      scope: 'standalone',
      workspacePath: workplaceDir,
    })
    await sessionIndex.upsert('project-session', {
      title: 'Project session',
      createdAt: 2,
      lastMessageAt: 20,
      mode: 'research',
      scope: 'project',
      projectId: 'project-1',
      workspacePath: join(dataDir, 'project-1'),
    })
    const updateMetadata = vi.fn(async () => undefined)
    const runner = {
      state: { model: config.agents.defaults.model },
      sessionManager: { updateMetadata },
    } as unknown as AgentRunner
    const server = await startLocalAppApiServer(runner, {
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
      rebuildRunner: vi.fn(async () => undefined),
      updateRuntimeConfig: vi.fn(async () => undefined),
    })
    const base = `http://127.0.0.1:${server.port}`

    try {
      const preflight = await fetch(`${base}${localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, 'standalone')}`, {
        method: 'OPTIONS',
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-methods')).toContain('PATCH')

      for (const [id, title] of [
        ['standalone', '  独立   对话  '],
        ['project-session', '项目对话'],
      ] as const) {
        const response = await fetch(`${base}${localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        })
        expect(response.status).toBe(200)
      }

      const sessions = await sessionIndex.list()
      expect(sessions.find((session) => session.id === 'standalone')).toMatchObject({
        title: '独立 对话',
        lastMessageAt: 10,
        scope: 'standalone',
      })
      expect(sessions.find((session) => session.id === 'project-session')).toMatchObject({
        title: '项目对话',
        lastMessageAt: 20,
        scope: 'project',
        projectId: 'project-1',
      })
      expect(updateMetadata).toHaveBeenNthCalledWith(1, asSessionId('standalone'), { title: '独立 对话' })
      expect(updateMetadata).toHaveBeenNthCalledWith(2, asSessionId('project-session'), { title: '项目对话' })

      const missing = await fetch(`${base}${localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, 'missing')}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Missing' }),
      })
      expect(missing.status).toBe(404)

      const empty = await fetch(`${base}${localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, 'standalone')}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '   ' }),
      })
      expect(empty.status).toBe(400)

      const tooLong = await fetch(`${base}${localAppApiItemPath(LOCAL_APP_API_PREFIXES.sessions, 'standalone')}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x'.repeat(61) }),
      })
      expect(tooLong.status).toBe(400)
      expect(updateMetadata).toHaveBeenCalledTimes(2)
    } finally {
      await server.stop()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
