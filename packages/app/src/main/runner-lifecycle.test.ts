// Runner lifetime: the build queue that keeps a start from building twice.
//
// The measured defect these cases guard: a configuration save that landed while
// the startup build was still running produced a second, concurrent Runner build
// on the same data root - two bootstrap commits, two attachment-protection
// passes and a `Git command aborted` from the second one.
import { describe, expect, it, vi } from 'vitest'
import type { BrandingConfig } from '@littlesheep/branding'
import type { Config } from '@littlesheep/config'
import { DEFAULT_CONFIG } from '@littlesheep/config'
import type { AgentRunner } from '@littlesheep/runner'
import { RunnerLifecycle } from './runner-lifecycle.js'

const BRANDING = { productName: 'test' } as unknown as BrandingConfig

function runner(): AgentRunner {
  return {
    state: { model: 'test/model' },
    activeRuns: { list: () => [], subscribe: () => () => undefined },
    shutdown: vi.fn(async () => undefined),
  } as unknown as AgentRunner
}

function createFixture(createRunner: () => Promise<AgentRunner>) {
  let config = structuredClone(DEFAULT_CONFIG) as Config
  const setRunner = vi.fn(async () => undefined)
  const lifecycle = new RunnerLifecycle({
    activity: { setRunners: vi.fn() } as never,
    createRunner,
    server: () => ({ setRunner, setConfig: vi.fn() }) as never,
    pluginHost: () => null,
    config: () => config,
    branding: () => BRANDING,
    roots: () => ({ dataDir: 'data', bootstrapDir: 'data' }),
    prepareConfig: (next) => ({ config: next, model: 'test/model' }),
    applyConfig: (next) => { config = next },
  })
  return {
    lifecycle,
    input: { config, branding: BRANDING, model: 'test/model', dataDir: 'data', bootstrapDir: 'data' },
    setRunner,
    config: () => config,
    /** A save that moves a field the Runner captures but no run reads live. */
    saveWorkspace: () => {
      config = {
        ...config,
        agents: { ...config.agents, defaults: { ...config.agents.defaults, workspace: 'moved' } },
      }
    },
  }
}

describe('RunnerLifecycle', () => {
  it('collapses a rebuild that arrives during the startup build into one build', async () => {
    let builds = 0
    let releaseBuild: (() => void) | undefined
    const started: string[] = []
    const fixture = createFixture(async () => {
      builds += 1
      started.push(`build-${builds}`)
      if (builds === 1) await new Promise<void>((resolve) => { releaseBuild = resolve })
      return runner()
    })

    const starting = fixture.lifecycle.start(fixture.input)
    // The save and the rebuild request both arrive while build 1 is running.
    const rebuilding = fixture.lifecycle.rebuildIfConfigChanged()
    fixture.saveWorkspace()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['build-1'])
    releaseBuild?.()
    await starting
    await rebuilding
    // The queued rebuild re-checks after build 1 published and finds the saved
    // revision already in effect, so it does not start a second build.
    expect(started).toEqual(['build-1'])
    expect(fixture.setRunner).not.toHaveBeenCalled()
  })

  it('keeps a rebuild queued behind a running build instead of running beside it', async () => {
    let builds = 0
    let releaseFirst: (() => void) | undefined
    const started: string[] = []
    const fixture = createFixture(async () => {
      builds += 1
      started.push(`build-${builds}`)
      if (builds === 1) await new Promise<void>((resolve) => { releaseFirst = resolve })
      return runner()
    })

    const starting = fixture.lifecycle.start(fixture.input)
    const firstRebuild = fixture.lifecycle.rebuild()
    // A save lands after build 1 captured its configuration, so the queued
    // rebuild still has work to do - but only after build 1 finishes.
    fixture.saveWorkspace()
    const secondRebuild = fixture.lifecycle.rebuild()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started).toEqual(['build-1'])
    releaseFirst?.()
    await starting
    await firstRebuild
    await secondRebuild
    expect(started).toEqual(['build-1', 'build-2'])
    expect(fixture.setRunner).toHaveBeenCalledTimes(1)
  })

  it('does not build again when the published Runner already matches the configuration', async () => {
    let builds = 0
    const fixture = createFixture(async () => { builds += 1; return runner() })

    await fixture.lifecycle.start(fixture.input)
    await fixture.lifecycle.rebuild()
    await fixture.lifecycle.rebuildIfConfigChanged()
    expect(builds).toBe(1)
  })
})
