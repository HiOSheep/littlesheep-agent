import { describe, expect, it } from 'vitest'
import { createBoundedByteLru } from './bounded-byte-lru'

describe('bounded byte LRU', () => {
  it('touches reads and evicts the least recently used entry', () => {
    const cache = createBoundedByteLru<string, string>({
      maxBytes: 100,
      maxEntries: 2,
      sizeOf: (value) => value.length,
    })

    cache.set('a', 'a')
    cache.set('b', 'bb')
    expect(cache.read('a')).toBe('a')
    cache.set('c', 'ccc')

    expect(cache.peek('a')).toBe('a')
    expect(cache.peek('b')).toBeUndefined()
    expect(cache.peek('c')).toBe('ccc')
  })

  it('tracks replacements and trims to the byte budget', () => {
    const cache = createBoundedByteLru<string, string>({
      maxBytes: 6,
      maxEntries: 10,
      sizeOf: (value) => value.length,
    })

    cache.set('a', 'aaaa')
    cache.set('a', 'aa')
    cache.set('b', 'bbbb')
    expect(cache.stats()).toEqual({ bytes: 6, entries: 2 })

    cache.set('c', 'c')
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.stats()).toEqual({ bytes: 5, entries: 2 })
  })

  it('does not retain one value larger than the whole budget', () => {
    const cache = createBoundedByteLru<string, string>({
      maxBytes: 3,
      maxEntries: 2,
      sizeOf: (value) => value.length,
    })

    expect(cache.set('large', 'four')).toBe(false)
    expect(cache.stats()).toEqual({ bytes: 0, entries: 0 })
  })
})
