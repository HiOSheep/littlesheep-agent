import { describe, expect, it } from 'vitest'
import { RUNTIME_MESSAGE_CATALOGUE, runtimeUserSentence } from './runtime-messages.js'

describe('runtime message catalogue', () => {
  it('gives every catalogued sentence a Chinese replacement that is not the original', () => {
    const entries = Object.entries(RUNTIME_MESSAGE_CATALOGUE)
    expect(entries.length).toBeGreaterThan(0)
    for (const [original, sentence] of entries) {
      expect(sentence).not.toBe(original)
      expect(sentence).toMatch(/\p{Script=Han}/u)
    }
  })

  it('falls back to the original sentence so a missing entry can never break a run', () => {
    const uncatalogued = 'Runtime says something the catalogue has never seen.'
    expect(runtimeUserSentence(uncatalogued)).toBe(uncatalogued)
    expect(runtimeUserSentence(Object.keys(RUNTIME_MESSAGE_CATALOGUE)[0]!, {})).toBe(
      Object.keys(RUNTIME_MESSAGE_CATALOGUE)[0],
    )
  })
})
