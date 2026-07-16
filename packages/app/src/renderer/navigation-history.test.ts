import { describe, expect, it } from 'vitest'
import {
  appendNavigationEntry,
  boundStringList,
  replaceActiveNavigationEntry,
} from './navigation-history'

describe('navigation history', () => {
  it('drops forward entries after navigating back and adding a new state', () => {
    const history = {
      entries: ['chat', 'workspace', 'settings'],
      index: 1,
    }

    expect(appendNavigationEntry(history, 'memory', (left, right) => left === right)).toEqual({
      entries: ['chat', 'workspace', 'memory'],
      index: 2,
    })
  })

  it('keeps only the newest bounded states', () => {
    let history = { entries: [0], index: 0 }
    for (let value = 1; value <= 8; value += 1) {
      history = appendNavigationEntry(history, value, (left, right) => left === right, 4)
    }

    expect(history).toEqual({ entries: [5, 6, 7, 8], index: 3 })
  })

  it('does not append an unchanged state', () => {
    const history = { entries: ['chat'], index: 0 }
    expect(appendNavigationEntry(history, 'chat', (left, right) => left === right)).toBe(history)
  })

  it('replaces the active state without dropping forward entries', () => {
    const history = {
      entries: ['chat', 'workspace', 'settings'],
      index: 0,
    }

    expect(replaceActiveNavigationEntry(history, 'chat-settled', (left, right) => left === right)).toEqual({
      entries: ['chat-settled', 'workspace', 'settings'],
      index: 0,
    })
  })

  it('does not replace an unchanged active state', () => {
    const history = { entries: ['chat', 'workspace'], index: 0 }
    expect(replaceActiveNavigationEntry(history, 'chat', (left, right) => left === right)).toBe(history)
  })

  it('deduplicates and bounds scalar lists', () => {
    expect(boundStringList(['a', 'b', 'a', '', 'c'], 2)).toEqual(['a', 'b'])
  })
})
