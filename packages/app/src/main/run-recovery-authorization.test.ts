import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import { asSessionId, type RunCheckpoint } from '@littlesheep/types'
import { ProjectIndex } from './project-index.js'
import { createMainRecoveryAuthorizationResolver } from './run-recovery-authorization.js'
import { SessionIndex } from './session-index.js'

const roots: string[] = []

describe('Main-owned durable recovery authorization', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('rebuilds current V2 facts for the same Main session and exact workspace', async () => {
    const fixture = await createFixture()
    const result = await fixture.resolve(fixture.input)

    expect(result).toMatchObject({
      permissionPolicyId: 'research',
      permissionPreset: 'workspace-write',
      permissionPolicyV2: {
        version: 2,
        preset: 'workspace-write',
        workspaceRoot: fixture.workspace,
      },
      workspaceContext: { boundaryKind: 'agent_workplace' },
    })
    expect(result?.memoryAccessGrant).toBeDefined()
    expect(result?.approve).toEqual(expect.any(Function))
    expect(await result?.approve?.('exec', { command: 'node -e "process.exit(0)"' })).toBe(false)
  })

  it('rejects a checkpoint whose Run or Session identity differs from the trusted recovery request', async () => {
    const fixture = await createFixture()
    expect(await fixture.resolve({ ...fixture.input, runId: 'forged-run' })).toBeUndefined()
    expect(await fixture.resolve({
      ...fixture.input,
      checkpoint: { ...fixture.input.checkpoint, sessionId: asSessionId('different-session') },
    })).toBeUndefined()
  })

  it('fails closed when the current Project identity is rebound away from the checkpoint workspace', async () => {
    const fixture = await createFixture()
    const projectWorkspace = join(fixture.dataDir, 'project-workspace')
    const movedWorkspace = join(fixture.dataDir, 'moved-project-workspace')
    await mkdir(projectWorkspace)
    await mkdir(movedWorkspace)
    const project = await fixture.projectIndex.ensure(projectWorkspace)
    await fixture.sessionIndex.upsert(fixture.sessionId, {
      scope: 'project',
      projectId: project.id,
      workspacePath: projectWorkspace,
    })
    const checkpoint = {
      ...fixture.input.checkpoint,
      resumeState: {
        ...fixture.input.checkpoint.resumeState,
        cwd: projectWorkspace,
        workspaceContext: { boundaryKind: 'project', projectId: project.id },
      },
    } as RunCheckpoint
    expect(await fixture.resolve({ ...fixture.input, checkpoint })).toMatchObject({
      permissionPolicyV2: { workspaceRoot: projectWorkspace },
    })

    await fixture.projectIndex.rebind(project.id, movedWorkspace)
    expect(await fixture.resolve({ ...fixture.input, checkpoint })).toBeUndefined()
  })

  it('fails closed when the current session policy or workspace authority is unavailable', async () => {
    const fixture = await createFixture()
    const declined = vi.fn()
    const missingSession = createMainRecoveryAuthorizationResolver(() => ({
      dataDir: fixture.dataDir,
      workplaceDir: fixture.workspace,
      getConfig: () => structuredClone(DEFAULT_CONFIG),
      getSessionIndex: () => null,
      getProjectIndex: () => fixture.projectIndex,
      onDecline: declined,
    }))
    expect(await missingSession(fixture.input)).toBeUndefined()
    expect(declined).toHaveBeenCalledWith(
      'Main session or project authority is unavailable',
      { sessionId: fixture.sessionId, runId: fixture.runId },
    )

    await fixture.sessionIndex.upsert(fixture.sessionId, { mode: 'read-only' })
    const narrowed = await fixture.resolve(fixture.input)
    expect(narrowed?.permissionPolicyV2?.preset).toBe('read-only')

    const changedWorkspace = await mkdtemp(join(tmpdir(), 'ls-recovery-moved-'))
    roots.push(changedWorkspace)
    await fixture.sessionIndex.upsert(fixture.sessionId, { workspacePath: changedWorkspace })
    expect(await fixture.resolve(fixture.input)).toBeUndefined()
  })
})

async function createFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'ls-recovery-auth-'))
  roots.push(dataDir)
  const workspace = join(dataDir, 'workplace')
  await mkdir(workspace)
  const sessionId = 'session-recovery-auth'
  const runId = 'run-recovery-auth'
  const sessionIndex = new SessionIndex({ dataDir, workplaceDir: workspace })
  const projectIndex = new ProjectIndex({ dataDir })
  await sessionIndex.upsert(sessionId, {
    title: 'recovery fixture',
    mode: 'workspace-write',
    permissionVersion: 2,
    scope: 'standalone',
    workspacePath: workspace,
  })
  const checkpoint = {
    runId,
    sessionId: asSessionId(sessionId),
    safeSegmentBoundary: { kind: 'execution_segment' },
    resumeState: {
      origin: 'app',
      attachmentCount: 0,
      cwd: workspace,
      permissionPolicyId: 'research',
      workspaceContext: { boundaryKind: 'agent_workplace' },
    },
  } as unknown as RunCheckpoint
  const input = {
    sessionId: asSessionId(sessionId),
    runId,
    checkpoint,
    signal: new AbortController().signal,
    protectedWriteRoots: [],
  }
  const resolve = createMainRecoveryAuthorizationResolver(() => ({
    dataDir,
    workplaceDir: workspace,
    getConfig: () => structuredClone(DEFAULT_CONFIG),
    getSessionIndex: () => sessionIndex,
    getProjectIndex: () => projectIndex,
  }))
  return { dataDir, workspace, sessionId, runId, sessionIndex, projectIndex, input, resolve }
}
