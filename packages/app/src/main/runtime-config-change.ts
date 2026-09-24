// Which saved configuration changes make the current Runner stale.
//
// The Runner captures one immutable `Config` when it is constructed and resolves
// a run's effective policy from that copy. Rebuilding only on a model or web
// change meant every other saved setting — the default workspace above all —
// kept describing the old world to the next run: the prompt named one directory
// while the tools wrote into another, and a permission, timeout or memory
// setting the user had just changed was not the one the run used.
//
// The comparison is deliberately about *fields*, not about a hand-picked list of
// interesting ones: a new setting that the Runner reads would otherwise be
// silently missed. Only keys that the Runner never reads are excluded.

import type { Config } from '@littlesheep/config'

/**
 * Config keys that no run reads.
 *
 * `desktop` is window/shell policy: `main/index.ts` reads it live from the
 * current config on every call, so a new Runner would not change anything.
 * `version` is the file format revision.
 */
const NON_RUNTIME_CONFIG_KEYS: readonly string[] = ['desktop', 'version']

/**
 * Config keys whose value differs between two revisions, sorted for stable
 * reporting. An empty result means the current Runner is still describing the
 * configuration the user has saved.
 */
export function changedRuntimeConfigKeys(previous: Config | null, next: Config): string[] {
  if (!previous) return ['<initial>']
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  const changed: string[] = []
  for (const key of keys) {
    if (NON_RUNTIME_CONFIG_KEYS.includes(key)) continue
    if (stableStringify((previous as Record<string, unknown>)[key])
      !== stableStringify((next as Record<string, unknown>)[key])) {
      changed.push(key)
    }
  }
  return changed.sort()
}

/** JSON with object keys sorted, so two equivalent configs serialize identically. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`
}

export interface RuntimeConfigUpdaterOptions {
  /**
   * The configuration the live Runner was built from; `null` before the first
   * build. This is *not* "the last saved configuration": a rebuild that failed
   * leaves the Runner on an older copy while the store already names the new one.
   */
  current: () => Config | null
  /** Normalize a candidate revision exactly as the startup path does. */
  prepare: (config: Config) => Config
  /** Persist and publish the accepted revision before anything reads it. */
  persist: (config: Config) => Promise<void>
  /** Replace the Runner, so the next run resolves policy from the new revision. */
  rebuild: () => Promise<void>
}

/**
 * The configuration-write transaction: normalize, persist, then replace the
 * Runner only when the accepted revision actually differs from the captured one.
 *
 * Writes are serialized, so two settings saved in quick succession cannot each
 * normalize against a different "current" config or interleave a persist with a
 * rebuild. A persist failure rejects the caller's promise and leaves the
 * previous revision in place — the save is not reported as applied.
 *
 * "Saved" and "in effect" are two different revisions and the updater keeps them
 * apart. `options.current()` answers only the second question, and it cannot be
 * trusted to keep answering it once a save has been written: the composition root
 * publishes the saved revision into the slot that read comes from. So a save
 * whose rebuild threw is remembered here as persisted-but-not-applied, and the
 * next save of that same revision replaces the Runner again instead of reporting
 * success for a setting no run is using.
 */
export function createRuntimeConfigUpdater(
  options: RuntimeConfigUpdaterOptions,
): (config: Config) => Promise<Config> {
  let queue: Promise<void> = Promise.resolve()
  /** Written to disk, but the rebuild that would make it effective failed. */
  let notApplied: Config | null = null
  return (config: Config): Promise<Config> => {
    const operation = queue.then(async () => {
      const normalized = options.prepare(config)
      // Compared against the live Runner's copy, which is why this runs before
      // the persist below publishes the new revision into the same slot.
      const changedKeys = changedRuntimeConfigKeys(options.current(), normalized)
      const retryNotApplied = notApplied !== null
        && changedRuntimeConfigKeys(notApplied, normalized).length === 0
      await options.persist(normalized)
      if (changedKeys.length > 0 || retryNotApplied) {
        try {
          await options.rebuild()
        } catch (error) {
          notApplied = normalized
          throw error
        }
        notApplied = null
      }
      return normalized
    })
    queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
