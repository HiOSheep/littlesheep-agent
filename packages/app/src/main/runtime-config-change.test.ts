// CE-02: what a saved configuration change has to do to the running Runner.
//
// The Runner captures one immutable Config at construction. Anything the run
// reads from that copy is stale the moment the user saves a different value, so
// the change has to replace it — not just for the model and web settings, which
// was the previous rule.
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@littlesheep/config'
import { changedRuntimeConfigKeys, createRuntimeConfigUpdater } from './runtime-config-change.js'

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

// CE-02: a save that did not persist is not a save. The updater owns the order
// (normalize, persist, then replace the Runner), so a persistence failure has to
// reject before anything reads the new revision.
describe('createRuntimeConfigUpdater', () => {
  function updater(options: { failPersist?: boolean } = {}) {
    const events: string[] = []
    const persisted: Config[] = []
    // This harness always holds a loaded revision; the updater's own contract
    // still allows null for a Main process that has not read one yet.
    let current: Config = config()
    const update = createRuntimeConfigUpdater({
      current: () => current,
      prepare: (next) => next,
      persist: async (next) => {
        events.push('persist')
        if (options.failPersist) throw new Error('disk is read-only')
        persisted.push(next)
        current = next
      },
      rebuild: async () => {
        events.push('rebuild')
      },
    })
    return { update, events, persisted, current: () => current }
  }

  it('persists before replacing the Runner, and only when something changed', async () => {
    const harness = updater()
    const next = config()
    next.agents.defaults.workspace = 'D:\\moved'

    await harness.update(next)

    expect(harness.events).toEqual(['persist', 'rebuild'])
    expect(harness.persisted).toHaveLength(1)

    const unchanged = updater()
    await unchanged.update(structuredClone(DEFAULT_CONFIG))
    expect(unchanged.events).toEqual(['persist'])
  })

  it('rejects a failed save without replacing the Runner or reporting success', async () => {
    const harness = updater({ failPersist: true })
    const before = harness.current()
    const next = config()
    next.agents.defaults.workspace = 'D:\\moved'

    await expect(harness.update(next)).rejects.toThrow('disk is read-only')

    // The caller sees the failure, the Runner keeps the previous revision, and
    // the next read still describes what is actually on disk.
    expect(harness.events).toEqual(['persist'])
    expect(harness.current()).toEqual(before)
  })

  it('serializes concurrent updates so they cannot mix two revisions', async () => {
    const harness = updater()
    const first = config()
    first.agents.defaults.workspace = 'D:\\first'
    const second = config()
    second.agents.defaults.workspace = 'D:\\second'

    await Promise.all([harness.update(first), harness.update(second)])

    // Both saves are applied in order; the last one is the current revision and
    // neither was normalized against a half-applied state.
    expect(harness.persisted.map((entry) => entry.agents.defaults.workspace))
      .toEqual(['D:\\first', 'D:\\second'])
    expect(harness.current().agents.defaults.workspace).toBe('D:\\second')
  })
})
