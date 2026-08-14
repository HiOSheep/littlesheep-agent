// Small renderer-side LRU for caches that must be bounded by count and memory.
export interface BoundedByteLruOptions<T> {
  maxBytes: number
  maxEntries: number
  sizeOf: (value: T) => number
}

export interface BoundedByteLruStats {
  bytes: number
  entries: number
}

export interface BoundedByteLru<K, T> {
  clear: () => void
  delete: (key: K) => boolean
  peek: (key: K) => T | undefined
  read: (key: K) => T | undefined
  set: (key: K, value: T) => boolean
  stats: () => BoundedByteLruStats
}

interface CacheEntry<T> {
  bytes: number
  value: T
}

export function createBoundedByteLru<K, T>(
  options: BoundedByteLruOptions<T>,
): BoundedByteLru<K, T> {
  const maxBytes = normalizeLimit(options.maxBytes)
  const maxEntries = normalizeLimit(options.maxEntries)
  const entries = new Map<K, CacheEntry<T>>()
  let totalBytes = 0

  function remove(key: K): boolean {
    const entry = entries.get(key)
    if (!entry) return false
    entries.delete(key)
    totalBytes -= entry.bytes
    return true
  }

  function set(key: K, value: T): boolean {
    remove(key)
    const bytes = normalizeSize(options.sizeOf(value))
    if (maxEntries === 0 || bytes > maxBytes) return false

    entries.set(key, { bytes, value })
    totalBytes += bytes
    trim()
    return entries.has(key)
  }

  function read(key: K): T | undefined {
    const entry = entries.get(key)
    if (!entry) return undefined
    entries.delete(key)
    entries.set(key, entry)
    return entry.value
  }

  function peek(key: K): T | undefined {
    return entries.get(key)?.value
  }

  function clear(): void {
    entries.clear()
    totalBytes = 0
  }

  function trim(): void {
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const oldest = entries.keys().next().value as K | undefined
      if (oldest === undefined) break
      remove(oldest)
    }
  }

  return {
    clear,
    delete: remove,
    peek,
    read,
    set,
    stats: () => ({ bytes: totalBytes, entries: entries.size }),
  }
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}

function normalizeSize(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.ceil(value))
}
