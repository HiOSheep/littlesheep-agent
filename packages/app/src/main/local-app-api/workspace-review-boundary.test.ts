import type { Config } from '@littlesheep/config'
import { describe, expect, it } from 'vitest'
import { resolveActiveWorkspaceRoot } from './workspace-support.js'

describe('workspace review root boundary', () => {
  it('accepts the active workspace and rejects an arbitrary query root', () => {
    const active = process.platform === 'win32' ? 'C:\\approved\\project' : '/approved/project'
    const outside = process.platform === 'win32' ? 'C:\\outside\\project' : '/outside/project'
    const config = {
      agents: { defaults: { workspace: active } },
    } as Config
    expect(resolveActiveWorkspaceRoot(
      new URL(`http://127.0.0.1/workspace/review?root=${encodeURIComponent(active)}`),
      config,
      active,
    )).toBe(active)
    expect(() => resolveActiveWorkspaceRoot(
      new URL(`http://127.0.0.1/workspace/review?root=${encodeURIComponent(outside)}`),
      config,
      active,
    )).toThrowError('workspace review is limited to the active workspace')
  })
})
