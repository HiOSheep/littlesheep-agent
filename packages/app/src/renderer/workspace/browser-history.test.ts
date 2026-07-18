import { describe, expect, it } from 'vitest'
import {
  MAX_WORKSPACE_BROWSER_HISTORY,
  appendWorkspaceBrowserHistory,
  createWorkspaceBrowserHistory,
  moveWorkspaceBrowserHistory,
  normalizeBrowserEventUrl,
  normalizeBrowserUrl,
  replaceWorkspaceBrowserHistory,
} from './browser-history'

describe('embedded browser history', () => {
  it('keeps browser navigation independent and bounded', () => {
    let state = createWorkspaceBrowserHistory('https://example.test/0')
    for (let index = 1; index <= MAX_WORKSPACE_BROWSER_HISTORY + 4; index += 1) {
      state = appendWorkspaceBrowserHistory(state, `https://example.test/${index}`)
    }
    expect(state.entries).toHaveLength(MAX_WORKSPACE_BROWSER_HISTORY)
    expect(state.entries[0]).toBe('https://example.test/5')
    expect(state.index).toBe(MAX_WORKSPACE_BROWSER_HISTORY - 1)
  })

  it('truncates forward entries after a new URL', () => {
    let state = createWorkspaceBrowserHistory('https://example.test/a')
    state = appendWorkspaceBrowserHistory(state, 'https://example.test/b')
    state = moveWorkspaceBrowserHistory(state, -1)
    state = appendWorkspaceBrowserHistory(state, 'https://example.test/c')
    expect(state.entries).toEqual([
      'https://example.test/a',
      'https://example.test/c',
    ])
    expect(state.index).toBe(1)
  })

  it('can replace redirects without creating an extra history step', () => {
    let state = createWorkspaceBrowserHistory('https://example.test/start')
    state = replaceWorkspaceBrowserHistory(state, 'https://example.test/redirected')
    expect(state.entries).toEqual(['https://example.test/redirected'])
    expect(state.index).toBe(0)
  })

  it('moves within the bounded stack without mutating its entries', () => {
    let state = createWorkspaceBrowserHistory('https://example.test/a')
    state = appendWorkspaceBrowserHistory(state, 'https://example.test/b')
    state = appendWorkspaceBrowserHistory(state, 'https://example.test/c')
    const entries = state.entries

    state = moveWorkspaceBrowserHistory(state, -1)
    expect(state.index).toBe(1)
    expect(state.entries).toBe(entries)

    state = moveWorkspaceBrowserHistory(state, -20)
    expect(state.index).toBe(0)

    state = moveWorkspaceBrowserHistory(state, 20)
    expect(state.index).toBe(2)
  })

  it('ignores non-finite history movement requests', () => {
    const state = createWorkspaceBrowserHistory('https://example.test/start')
    expect(moveWorkspaceBrowserHistory(state, Number.NaN)).toBe(state)
    expect(moveWorkspaceBrowserHistory(state, Number.POSITIVE_INFINITY)).toBe(state)
    expect(moveWorkspaceBrowserHistory(state, Number.NEGATIVE_INFINITY)).toBe(state)
  })

  it('accepts bare user addresses but rejects non-web navigation events', () => {
    expect(normalizeBrowserUrl('example.test/path')).toBe('https://example.test/path')
    expect(normalizeBrowserEventUrl('https://example.test/path')).toBe('https://example.test/path')
    expect(normalizeBrowserEventUrl('about:blank')).toBe('')
    expect(normalizeBrowserEventUrl('mailto:user@example.test')).toBe('')
  })
})
