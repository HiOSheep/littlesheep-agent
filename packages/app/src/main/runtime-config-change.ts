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
  /** The Runner's current configuration copy; `null` before the first build. */
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
 */
export function createRuntimeConfigUpdater(
  options: RuntimeConfigUpdaterOptions,
): (config: Config) => Promise<Config> {
  let queue: Promise<void> = Promise.resolve()
  return (config: Config): Promise<Config> => {
    const operation = queue.then(async () => {
      const normalized = options.prepare(config)
      const changedKeys = changedRuntimeConfigKeys(options.current(), normalized)
      await options.persist(normalized)
      if (changedKeys.length > 0) await options.rebuild()
      return normalized
    })
    queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
