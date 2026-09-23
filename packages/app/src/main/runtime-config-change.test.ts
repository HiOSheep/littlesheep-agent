// CE-02: what a saved configuration change has to do to the running Runner.
//
// The Runner captures one immutable Config at construction. Anything the run
// reads from that copy is stale the moment the user saves a different value, so
// the change has to replace it — not just for the model and web settings, which
// was the previous rule.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config'
import { changedRuntimeConfigKeys } from './runtime-config-change.js'

function config(): Config {
  return structuredClone(DEFAULT_CONFIG)
}

describe('changedRuntimeConfigKeys', () => {
  it('reports nothing when the saved revision matches the Runner copy', () => {
    expect(changedRuntimeConfigKeys(config(), config())).toEqual([])
  })

  it('treats the first configuration as a required initial build', () => {
    expect(changedRuntimeConfigKeys(null, config())).toEqual(['<initial>'])
  })

  it('reports a workspace-only change, which the previous rule ignored', () => {
    const previous = config()
    const next = config()
    next.agents.defaults.workspace = 'D:\\projects\\with space'

    expect(changedRuntimeConfigKeys(previous, next)).toEqual(['agents'])
  })

  it('reports every key the run reads, not a hand-picked subset', () => {
    const cases: Array<[string, (next: Config) => void]> = [
      ['agents', (next) => { next.agents.defaults.model = 'other/model' }],
      ['tools', (next) => { next.tools.invocationTimeoutMs += 1 }],
      ['web', (next) => { next.web.enabled = !next.web.enabled }],
      ['memory', (next) => { next.memory.experienceWriteThreshold += 1 }],
      ['sessions', (next) => { next.sessions.compaction.keepRecent += 1 }],
      ['skills', (next) => { next.skills.extraDirs = [...next.skills.extraDirs, 'extra-skills'] }],
    ]
    for (const [key, mutate] of cases) {
      const previous = config()
      const next = config()
      mutate(next)
      expect(changedRuntimeConfigKeys(previous, next), key).toEqual([key])
    }
  })

  it('does not rebuild for window policy, which every reader takes from the live config', () => {
    const previous = config()
    const next = config()
    next.desktop.closePolicy = next.desktop.closePolicy === 'always-background'
      ? 'background-while-active'
      : 'always-background'

    expect(changedRuntimeConfigKeys(previous, next)).toEqual([])
  })

  it('is insensitive to key order and to equivalent values', () => {
    const previous = config()
    const reordered = Object.fromEntries(
      Object.entries(config()).reverse(),
    ) as unknown as Config

    expect(changedRuntimeConfigKeys(previous, reordered)).toEqual([])
  })
})
