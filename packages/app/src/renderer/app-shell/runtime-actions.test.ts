// CE-02: where the directory picker's decision has to land.
//
// A project session runs where its project is, so saving the default workspace
// does not move it: the user's explicit pick is the only thing that may, and it
// has to reach *both* places or the two facts disagree — the session stays where
// it was while the default moves to the new directory.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { RuntimeState } from '../api'
import { createRuntimeActions } from './runtime-actions'

const updateRuntime = vi.fn()
const getRuntime = vi.fn()
const updateSessionWorkspace = vi.fn()

vi.mock('../api', () => ({
  getRuntime: (...args: unknown[]) => getRuntime(...args),
  updateRuntime: (...args: unknown[]) => updateRuntime(...args),
}))
vi.mock('../api/sessions', () => ({
  updateSessionWorkspace: (...args: unknown[]) => updateSessionWorkspace(...args),
}))

function runtimeState(workspace: string): RuntimeState {
  return { workspace } as RuntimeState
}

function actions(overrides: { mounted?: boolean } = {}) {
  const setRuntime = vi.fn()
  const setRuntimeError = vi.fn()
  const created = createRuntimeActions({
    appMountedRef: { current: overrides.mounted ?? true },
    runtime: runtimeState('D:\\default'),
    setRuntime,
    setRuntimeError,
    alignWorkspacePanelToWorkspaceRoot: vi.fn(),
    notifyRuntimeSettingChanges: vi.fn(async () => undefined),
    refreshProjects: vi.fn(async () => undefined),
    modelPatchSequenceRef: { current: 0 },
    pendingModelPatchRef: { current: null },
  })
  return { created, setRuntime, setRuntimeError }
}

beforeEach(() => {
  vi.clearAllMocks()
  updateRuntime.mockResolvedValue(runtimeState('D:\\picked'))
})

describe('chooseWorkspacePath', () => {
  it('moves a project session and the saved default together', async () => {
    const { created } = actions()

    await created.chooseWorkspacePath({
      selectDirectory: async () => 'D:\\picked',
      sessionId: 'session-project',
      sessionScope: 'project',
    })

    expect(updateSessionWorkspace).toHaveBeenCalledWith('session-project', 'D:\\picked')
    expect(updateRuntime).toHaveBeenCalledWith({ workspace: 'D:\\picked' })
    // The session write happens first: a failure there must not leave the default
    // pointing at a directory the session does not use.
    expect(updateSessionWorkspace.mock.invocationCallOrder[0])
      .toBeLessThan(updateRuntime.mock.invocationCallOrder[0]!)
  })

  it('leaves a standalone session to follow the saved default', async () => {
    const { created } = actions()

    await created.chooseWorkspacePath({
      selectDirectory: async () => 'D:\\picked',
      sessionId: 'session-standalone',
      sessionScope: 'standalone',
    })

    expect(updateSessionWorkspace).not.toHaveBeenCalled()
    expect(updateRuntime).toHaveBeenCalledWith({ workspace: 'D:\\picked' })
  })

  it('does nothing when the picker is cancelled or the window is gone', async () => {
    const cancelled = actions()
    await cancelled.created.chooseWorkspacePath({
      selectDirectory: async () => null,
      sessionId: 'session-project',
      sessionScope: 'project',
    })
    expect(updateSessionWorkspace).not.toHaveBeenCalled()
    expect(updateRuntime).not.toHaveBeenCalled()

    const unmounted = actions({ mounted: false })
    await unmounted.created.chooseWorkspacePath({
      selectDirectory: async () => 'D:\\picked',
      sessionId: 'session-project',
      sessionScope: 'project',
    })
    expect(updateSessionWorkspace).not.toHaveBeenCalled()
    expect(updateRuntime).not.toHaveBeenCalled()
  })

  it('reports a failed session move instead of half-applying the switch', async () => {
    updateSessionWorkspace.mockRejectedValueOnce(new Error('session workspace is not an existing directory'))
    const { created, setRuntimeError } = actions()

    await created.chooseWorkspacePath({
      selectDirectory: async () => 'D:\\picked',
      sessionId: 'session-project',
      sessionScope: 'project',
    })

    expect(setRuntimeError).toHaveBeenCalledWith('session workspace is not an existing directory')
    expect(updateRuntime).not.toHaveBeenCalled()
  })
})
