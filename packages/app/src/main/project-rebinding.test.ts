import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ArchiveIndex } from './archive-index.js'
import { ProjectIndex } from './project-index.js'
import { ProjectRebindingService } from './project-rebinding.js'
import { SessionIndex } from './session-index.js'
import { TerminalActivityIndex } from './terminal-activity-index.js'
import { WorkspaceArtifactIndex } from './workspace-artifact-index.js'
import { WorkspaceLayoutIndex } from './workspace-layout-index.js'

function fileTab(root: string, path: string): string {
  return `file:${encodeURIComponent(root)}|${encodeURIComponent(path)}`
}

describe('ProjectRebindingService', () => {
  it('preserves project identity and migrates dependent indexes without touching standalone sessions', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-project-rebind-'))
    try {
      const fromPath = join(dataDir, 'Original')
      const toPath = join(dataDir, 'Moved')
      mkdirSync(fromPath, { recursive: true })
      mkdirSync(toPath, { recursive: true })
      const projectIndex = new ProjectIndex({ dataDir })
      const sessionIndex = new SessionIndex({ dataDir })
      const archiveIndex = new ArchiveIndex({ dataDir })
      const workspaceArtifactIndex = new WorkspaceArtifactIndex({ dataDir })
      const terminalActivityIndex = new TerminalActivityIndex({ dataDir })
      const workspaceLayoutIndex = new WorkspaceLayoutIndex({ dataDir })
      const project = await projectIndex.ensure(fromPath)
      await sessionIndex.upsert('project-session', {
        title: 'Project session', createdAt: 1, lastMessageAt: 2, mode: 'research',
        scope: 'project', projectId: project.id, workspacePath: fromPath,
      })
      await sessionIndex.upsert('standalone-session', {
        title: 'Standalone session', createdAt: 1, lastMessageAt: 2, mode: 'research',
        scope: 'standalone', workspacePath: fromPath,
      })
      const archivedSession = (await sessionIndex.list()).find((session) => session.id === 'project-session')!
      await archiveIndex.archiveSession({ ...archivedSession, id: 'archived-project-session' })
      await workspaceArtifactIndex.append({
        path: join(fromPath, 'project.txt'), action: 'modified', source: 'agent',
        workspacePath: fromPath, sessionId: 'project-session', projectId: project.id,
      })
      await workspaceArtifactIndex.append({
        path: join(fromPath, 'standalone.txt'), action: 'modified', source: 'user',
        workspacePath: fromPath, sessionId: 'standalone-session',
      })
      const terminalBase = {
        command: 'pwd', durationMs: 1, exitCode: 0, signal: null,
        timedOut: false, truncated: false, stdout: '', stderr: '',
      }
      await terminalActivityIndex.append({
        ...terminalBase, cwd: join(fromPath, 'src'), workspacePath: fromPath, sessionId: 'project-session',
      })
      await terminalActivityIndex.append({
        ...terminalBase, cwd: fromPath, workspacePath: fromPath, sessionId: 'standalone-session',
      })
      const oldFile = join(fromPath, 'src', 'index.ts')
      const oldTab = fileTab(fromPath, oldFile)
      await workspaceLayoutIndex.save({
        workspacePath: fromPath,
        width: 420,
        collapsed: false,
        fullscreen: false,
        activeTab: oldTab,
        openTabs: ['review', oldTab],
        openRequest: { root: fromPath, path: oldFile },
        fileNavigatorCollapsed: false,
        drafts: {
          [oldTab]: { path: oldFile, editorText: 'changed', savedText: 'saved', editing: true },
        },
      })

      const memoryCalls: Array<[string, string]> = []
      let runtimePath = fromPath
      const service = new ProjectRebindingService({
        dataDir,
        projectIndex,
        sessionIndex,
        archiveIndex,
        workspaceArtifactIndex,
        terminalActivityIndex,
        workspaceLayoutIndex,
        rebindMemory: async (before, after) => { memoryCalls.push([before.path, after.path]) },
        rebindRuntimeWorkspace: async (before, after) => {
          if (runtimePath === before) runtimePath = after
        },
      })

      const result = await service.rebind(project.id, toPath)

      expect(result.project.id).toBe(project.id)
      expect(result.project.path).toBe(toPath)
      expect(result.project.previousPaths).toEqual([fromPath])
      expect(result.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'project-session', workspacePath: toPath }),
      ]))
      const sessions = await sessionIndex.list()
      expect(sessions.find((session) => session.id === 'standalone-session')?.workspacePath).toBe(fromPath)
      expect((await archiveIndex.list()).sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'archived-project-session', workspacePath: toPath }),
      ]))
      expect(await workspaceArtifactIndex.list({ workspacePath: toPath })).toEqual([
        expect.objectContaining({ path: join(toPath, 'project.txt'), projectId: project.id }),
      ])
      const standaloneArtifacts = await workspaceArtifactIndex.list({ workspacePath: fromPath })
      expect(standaloneArtifacts).toEqual([
        expect.objectContaining({ path: join(fromPath, 'standalone.txt'), sessionId: 'standalone-session' }),
      ])
      expect(standaloneArtifacts[0]).not.toHaveProperty('projectId')
      expect(await terminalActivityIndex.list({ workspacePath: toPath })).toEqual([
        expect.objectContaining({ cwd: join(toPath, 'src'), sessionId: 'project-session' }),
      ])
      expect(await terminalActivityIndex.list({ workspacePath: fromPath })).toEqual([
        expect.objectContaining({ sessionId: 'standalone-session' }),
      ])
      const layout = await workspaceLayoutIndex.read()
      const newFile = join(toPath, 'src', 'index.ts')
      const newTab = fileTab(toPath, newFile)
      expect(layout).toMatchObject({
        workspacePath: toPath,
        activeTab: newTab,
        openRequest: { root: toPath, path: newFile },
      })
      expect(layout?.drafts[newTab]?.path).toBe(newFile)
      expect(memoryCalls).toEqual([[fromPath, toPath]])
      expect(runtimePath).toBe(toPath)
      expect(existsSync(join(dataDir, 'projects', 'rebind-operation.json'))).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('recovers idempotently when a process stops after applying a step but before journaling it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-project-rebind-recovery-'))
    try {
      const fromPath = join(dataDir, 'Original')
      const toPath = join(dataDir, 'Moved')
      mkdirSync(fromPath, { recursive: true })
      mkdirSync(toPath, { recursive: true })
      const projectIndex = new ProjectIndex({ dataDir })
      const sessionIndex = new SessionIndex({ dataDir })
      const archiveIndex = new ArchiveIndex({ dataDir })
      const workspaceArtifactIndex = new WorkspaceArtifactIndex({ dataDir })
      const terminalActivityIndex = new TerminalActivityIndex({ dataDir })
      const workspaceLayoutIndex = new WorkspaceLayoutIndex({ dataDir })
      const project = await projectIndex.ensure(fromPath)
      let memoryCalls = 0
      const options = {
        dataDir,
        projectIndex,
        sessionIndex,
        archiveIndex,
        workspaceArtifactIndex,
        terminalActivityIndex,
        workspaceLayoutIndex,
        rebindMemory: async () => { memoryCalls += 1 },
        rebindRuntimeWorkspace: async () => undefined,
      }
      const interrupted = new ProjectRebindingService({
        ...options,
        faultInjector: (step, phase) => {
          if (step === 'memory' && phase === 'after-apply') throw new Error('simulated process stop')
        },
      })

      await expect(interrupted.rebind(project.id, toPath)).rejects.toThrow('simulated process stop')
      expect((await projectIndex.list())[0]?.path).toBe(fromPath)
      expect(existsSync(join(dataDir, 'projects', 'rebind-operation.json'))).toBe(true)

      const recovered = await new ProjectRebindingService(options).recoverPending()

      expect(recovered).toMatchObject({ recovered: true, project: { id: project.id, path: toPath } })
      expect(memoryCalls).toBe(2)
      expect(existsSync(join(dataDir, 'projects', 'rebind-operation.json'))).toBe(false)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('rejects a target path already owned by an active or archived project', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-project-rebind-conflict-'))
    try {
      const projectIndex = new ProjectIndex({ dataDir })
      const sessionIndex = new SessionIndex({ dataDir })
      const archiveIndex = new ArchiveIndex({ dataDir })
      const workspaceArtifactIndex = new WorkspaceArtifactIndex({ dataDir })
      const terminalActivityIndex = new TerminalActivityIndex({ dataDir })
      const workspaceLayoutIndex = new WorkspaceLayoutIndex({ dataDir })
      const first = await projectIndex.ensure(join(dataDir, 'Alpha'))
      const second = await projectIndex.ensure(join(dataDir, 'Beta'))
      const service = new ProjectRebindingService({
        dataDir,
        projectIndex,
        sessionIndex,
        archiveIndex,
        workspaceArtifactIndex,
        terminalActivityIndex,
        workspaceLayoutIndex,
        rebindMemory: async () => undefined,
        rebindRuntimeWorkspace: async () => undefined,
      })

      await expect(service.rebind(first.id, second.path)).rejects.toThrow(second.id)
      await projectIndex.remove(second.id)
      await archiveIndex.archiveProject(second)
      await expect(service.rebind(first.id, second.path)).rejects.toThrow(second.id)
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
