import { describe, expect, it } from 'vitest'
import {
  MAX_WORKSPACE_BROWSER_HISTORY,
  appendWorkspaceBrowserHistory,
  browserUrlsShareHistoryEntry,
  compactWorkspaceBrowserHistory,
  createWorkspaceBrowserHistory,
  getBrowserHistoryIdentity,
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

  it('treats one Bilibili BV video as one meaningful history entry', () => {
    let state = createWorkspaceBrowserHistory(
      'https://www.bilibili.com/video/BV1PXNZ6DEx4/?spm_id_from=333.1007',
    )
    state = appendWorkspaceBrowserHistory(
      state,
      'https://www.bilibili.com/video/BV1PXNZ6DEx4/?vd_source=source#reply123',
    )

    expect(state.entries).toEqual([
      'https://www.bilibili.com/video/BV1PXNZ6DEx4/?vd_source=source#reply123',
    ])
    expect(browserUrlsShareHistoryEntry(
      state.entries[0]!,
      'https://m.bilibili.com/video/BV1PXNZ6DEx4?p=2',
    )).toBe(true)
    expect(browserUrlsShareHistoryEntry(
      state.entries[0]!,
      'https://www.bilibili.com/video/BV1xx411c7mD',
    )).toBe(false)
  })

  it('keeps content identifiers but ignores transient detail state across sites', () => {
    expect(getBrowserHistoryIdentity(
      'https://www.youtube.com/watch?v=video-a&t=120&utm_source=test',
    )).toBe(getBrowserHistoryIdentity(
      'https://m.youtube.com/watch?v=video-a#comments',
    ))
    expect(browserUrlsShareHistoryEntry(
      'https://example.test/articles/42?utm_source=test#comments',
      'https://example.test/articles/42?tab=discussion&sort=newest',
    )).toBe(true)
    expect(browserUrlsShareHistoryEntry(
      'https://example.test/search?q=memory',
      'https://example.test/search?q=agent',
    )).toBe(false)
    expect(browserUrlsShareHistoryEntry(
      'https://example.test/articles/42',
      'https://example.test/articles/43',
    )).toBe(false)
  })

  it('compacts adjacent persisted detail states without collapsing real revisits', () => {
    const compacted = compactWorkspaceBrowserHistory({
      entries: [
        'https://www.bilibili.com/video/BV1PXNZ6DEx4',
        'https://www.bilibili.com/video/BV1PXNZ6DEx4#reply-1',
        'https://www.bilibili.com/video/BV1xx411c7mD',
        'https://www.bilibili.com/video/BV1PXNZ6DEx4',
      ],
      index: 1,
    })

    expect(compacted.entries).toEqual([
      'https://www.bilibili.com/video/BV1PXNZ6DEx4#reply-1',
      'https://www.bilibili.com/video/BV1xx411c7mD',
      'https://www.bilibili.com/video/BV1PXNZ6DEx4',
    ])
    expect(compacted.index).toBe(0)
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

  it('reads a bare loopback address as the local development server it is', () => {
    // A person who started their own server types the host and port; HTTPS there is a scheme
    // the server does not answer (UX-31 item 2).
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173/')
    expect(normalizeBrowserUrl('127.0.0.1:8000/app?x=1')).toBe('http://127.0.0.1:8000/app?x=1')
    expect(normalizeBrowserUrl('[::1]:5173')).toBe('http://[::1]:5173/')
    expect(normalizeBrowserUrl('preview.localhost:3000')).toBe('http://preview.localhost:3000/')
    // An explicit scheme is always kept, and public hosts keep the HTTPS assumption.
    expect(normalizeBrowserUrl('https://localhost:5173')).toBe('https://localhost:5173/')
    expect(normalizeBrowserUrl('example.test:8443')).toBe('https://example.test:8443/')
    // A name that merely contains "localhost" is not loopback.
    expect(normalizeBrowserUrl('localhost.example.test')).toBe('https://localhost.example.test/')
  })
})
