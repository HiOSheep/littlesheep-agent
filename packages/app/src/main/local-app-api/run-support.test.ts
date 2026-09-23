import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config'
import { SessionIndex } from '../session-index.js'
import { ProjectIndex } from '../project-index.js'
import {
  resolveOwnedRunWorkspace,
  resolveRunWorkspace,
  resolveRunWorkspaceContext,
  updateSessionIndex,
  withPersistedSessionPermissionMode,
} from './run-support.js'

describe('run permission mode continuity', () => {
  it('uses the persisted session mode when a partial run request omits it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-support-'))
    try {
      const workplaceDir = join(dataDir, 'workplace')
      const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
      await sessionIndex.upsert('session-1', {
        title: 'Session',
        mode: 'full',
        scope: 'standalone',
        workspacePath: workplaceDir,
      })

      await expect(withPersistedSessionPermissionMode(sessionIndex, {
        sessionId: 'session-1',
        text: 'run',
      })).resolves.toMatchObject({ permissionMode: 'full' })

      await updateSessionIndex(sessionIndex, 'session-1', { sessionId: 'session-1' }, {
        scope: 'standalone',
      }, workplaceDir)
      await expect(sessionIndex.list()).resolves.toEqual([
        expect.objectContaining({ id: 'session-1', mode: 'full' }),
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('does not let a legacy coding behavior request overwrite the permission policy', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-support-'))
    try {
      const workplaceDir = join(dataDir, 'workplace')
      const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
      await sessionIndex.upsert('session-1', { mode: 'restricted', scope: 'standalone' })
      await updateSessionIndex(sessionIndex, 'session-1', { mode: 'coding' }, {
        scope: 'standalone',
      }, workplaceDir)
      await expect(sessionIndex.list()).resolves.toEqual([
        expect.objectContaining({ id: 'session-1', mode: 'restricted' }),
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('keeps the actual resolved mode when checkpoint completion updates the index', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-run-support-'))
    try {
      const workplaceDir = join(dataDir, 'workplace')
      const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
      await sessionIndex.upsert('session-1', { mode: 'research', scope: 'standalone' })
      await updateSessionIndex(sessionIndex, 'session-1', { permissionMode: 'full' }, {
        scope: 'standalone',
      }, workplaceDir)
      await expect(sessionIndex.list()).resolves.toEqual([
        expect.objectContaining({ id: 'session-1', mode: 'full' }),
      ])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

// CE-01/CE-02: one workspace fact per run, resolved at the run entry.
const workplace = resolve('D:\\data-root\\workplace')

function config(workspace: string): Config {
  const next = structuredClone(DEFAULT_CONFIG)
  next.agents.defaults.workspace = workspace
  return next
}

describe('resolveRunWorkspace', () => {
  it('prefers the request workspace over the configured default', () => {
    expect(resolveRunWorkspace(
      { workspace: 'D:\\projects\\game' },
      config('D:\\elsewhere'),
      workplace,
    )).toBe(resolve('D:\\projects\\game'))
  })

  it('falls back to the configured default, then to the workplace', () => {
    expect(resolveRunWorkspace({}, config('D:\\elsewhere'), workplace))
      .toBe(resolve('D:\\elsewhere'))
    const empty = structuredClone(DEFAULT_CONFIG)
    empty.agents.defaults.workspace = ''
    expect(resolveRunWorkspace({}, empty, workplace)).toBe(workplace)
  })

  it('normalizes to one absolute path, including a directory with spaces', () => {
    const resolved = resolveRunWorkspace(
      { workspace: 'D:\\projects\\my game ' },
      config('D:\\elsewhere'),
      workplace,
    )

    expect(isAbsolute(resolved)).toBe(true)
    // The same value the prompt and the tool context use: no trailing separator
    // and no relative segment left for a later `resolve` to reinterpret.
    expect(resolved).toBe(resolve('D:\\projects\\my game'))
    expect(resolved).toBe(resolved.trim())
  })

  it('ignores a blank request workspace instead of using it as a path', () => {
    expect(resolveRunWorkspace(
      { workspace: '   ' },
      config('D:\\projects\\bound'),
      workplace,
    )).toBe(resolve('D:\\projects\\bound'))
  });

  it('keeps a directory whose name is not ASCII intact', () => {
    const selected = 'D:\\项目\\我的 游戏'
    const resolved = resolveRunWorkspace({ workspace: selected }, config('D:\\elsewhere'), workplace)

    expect(resolved).toBe(resolve(selected))
    // Normalization must not transliterate, escape or drop the name: the model,
    // the shell and the artifact index all have to see the same characters.
    expect(resolved).toContain('项目')
    expect(resolved).toContain('我的 游戏')
  })

  // CE-02: the renderer sends the runtime's current workspace with every run, so
  // without this a saved default (or another window's session switch) moved a
  // project's session into another directory — and the completion bookkeeping
  // then rewrote the session's recorded directory to match, making the move
  // permanent. A project session runs where its project is.
  it('keeps a project session in its own directory when the request names another', () => {
    expect(resolveRunWorkspace(
      { workspace: 'D:\\elsewhere\\saved-default' },
      config('D:\\elsewhere\\saved-default'),
      workplace,
      { projectPath: 'D:\\projects\\alpha' },
    )).toBe(resolve('D:\\projects\\alpha'))
  })

  it('prefers the directory this session last worked in over the project directory', () => {
    expect(resolveRunWorkspace(
      { workspace: 'D:\\elsewhere' },
      config('D:\\elsewhere'),
      workplace,
      { projectPath: 'D:\\projects\\alpha', sessionWorkspacePath: 'D:\\projects\\alpha\\sub' },
    )).toBe(resolve('D:\\projects\\alpha\\sub'))
  })

  it('still follows the request for a session with no binding of its own', () => {
    // A standalone session has no facts to pass, so saving a new default keeps
    // moving it — only a bound session is pinned.
    expect(resolveRunWorkspace(
      { workspace: 'D:\\elsewhere' },
      config('D:\\default'),
      workplace,
      {},
    )).toBe(resolve('D:\\elsewhere'))
  })
})

describe('resolveRunWorkspaceContext', () => {
  it('distinguishes the managed workplace from a user-chosen directory', () => {
    expect(resolveRunWorkspaceContext(workplace, { scope: 'standalone' }, workplace))
      .toEqual({ boundaryKind: 'agent_workplace' })
    expect(resolveRunWorkspaceContext(resolve('D:\\projects\\game'), { scope: 'standalone' }, workplace))
      .toEqual({ boundaryKind: 'user_workplace' })
  })

  it('keeps a project session bound to its project even when the directory differs', () => {
    expect(resolveRunWorkspaceContext(resolve('D:\\default'), {
      scope: 'project',
      projectId: 'project-a',
    }, workplace)).toEqual({ boundaryKind: 'project', projectId: 'project-a' })
  })
})

// The route-level rule: ownership is resolved first, and a project-bound session
// then runs in its project's directory no matter what the request names.
describe('resolveOwnedRunWorkspace', () => {
  async function contextWithProject(dataDir: string, workplaceDir: string) {
    const sessionIndex = new SessionIndex({ dataDir, workplaceDir })
    const projectIndex = new ProjectIndex({ dataDir })
    const project = await projectIndex.ensure(resolve('D:\\projects\\alpha'))
    await sessionIndex.upsert('session-a', {
      title: 'Alpha session',
      mode: 'research',
      scope: 'project',
      projectId: project.id,
      workspacePath: project.path,
    })
    return {
      sessionIndex,
      projectIndex,
      workspaceArtifactIndex: {} as never,
      project,
    }
  }

  it('ignores a saved default that would move a project session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-owned-workspace-'))
    try {
      const workplaceDir = join(dataDir, 'workplace')
      const context = await contextWithProject(dataDir, workplaceDir)
      const moved = join(dataDir, 'saved-default')

      await expect(resolveOwnedRunWorkspace(
        context,
        { sessionId: 'session-a', workspace: moved },
        { scope: 'project', projectId: context.project.id },
        config(moved),
        workplaceDir,
      )).resolves.toBe(resolve('D:\\projects\\alpha'))
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('follows the request for a standalone session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ls-owned-workspace-'))
    try {
      const workplaceDir = join(dataDir, 'workplace')
      const context = await contextWithProject(dataDir, workplaceDir)
      const chosen = join(dataDir, 'chosen')

      await expect(resolveOwnedRunWorkspace(
        context,
        { sessionId: 'session-standalone', workspace: chosen },
        { scope: 'standalone' },
        config(join(dataDir, 'other')),
        workplaceDir,
      )).resolves.toBe(resolve(chosen))
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
