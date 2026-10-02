// The empty state's wording: several greetings rather than one, and the same conversation always
// gets the same one.
import { describe, expect, it } from 'vitest'
import { EMPTY_HINTS, emptyHintFor } from './empty-hint'

describe('empty conversation hint', () => {
  it('offers a range, and every entry says something different', () => {
    expect(EMPTY_HINTS.length).toBeGreaterThanOrEqual(5)
    expect(new Set(EMPTY_HINTS.map((hint) => hint.title)).size).toBe(EMPTY_HINTS.length)
    expect(new Set(EMPTY_HINTS.map((hint) => hint.copy)).size).toBe(EMPTY_HINTS.length)
    for (const hint of EMPTY_HINTS) {
      expect(hint.title.trim().length).toBeGreaterThan(0)
      expect(hint.copy.trim().length).toBeGreaterThan(0)
    }
  })

  it('answers a seed with the same entry every time, and reaches more than one entry', () => {
    const seeds = Array.from({ length: 60 }, (_, index) => `session-${index}`)
    const titles = seeds.map((seed) => emptyHintFor(seed).title)

    for (const seed of seeds) expect(emptyHintFor(seed)).toBe(emptyHintFor(seed))
    // A re-render must not change the line, but a set of conversations must not all read alike.
    expect(new Set(titles).size).toBeGreaterThan(1)
    for (const title of titles) expect(EMPTY_HINTS.some((hint) => hint.title === title)).toBe(true)
  })
})
