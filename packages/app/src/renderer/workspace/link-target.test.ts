import { describe, expect, it } from 'vitest'
import { resolveLinkTarget } from './link-target'

describe('workspace link targets', () => {
  it('keeps web links in the internal browser contract', () => {
    expect(resolveLinkTarget('https://example.com/a?q=1', 'D:\\repo')).toEqual({
      kind: 'web',
      href: 'https://example.com/a?q=1',
    })
  })

  it('resolves Windows, file URL, and relative paths as files', () => {
    expect(resolveLinkTarget('D:/repo/docs/readme.md', 'D:\\repo')).toEqual({
      kind: 'file',
      path: 'D:\\repo\\docs\\readme.md',
    })
    expect(resolveLinkTarget('file:///D:/repo/a%20b.txt', 'D:\\repo')).toEqual({
      kind: 'file',
      path: 'D:\\repo\\a b.txt',
    })
    expect(resolveLinkTarget('../notes.md', 'D:\\repo\\docs')).toEqual({
      kind: 'file',
      path: 'D:\\repo\\notes.md',
    })
  })

  it('does not treat active or unsupported schemes as files', () => {
    expect(resolveLinkTarget('javascript:alert(1)', 'D:\\repo').kind).toBe('unsupported')
    expect(resolveLinkTarget('data:text/html,hello', 'D:\\repo').kind).toBe('unsupported')
    expect(resolveLinkTarget('mailto:user@example.com', 'D:\\repo').kind).toBe('unsupported')
    expect(resolveLinkTarget('#section', 'D:\\repo')).toEqual({ kind: 'fragment', href: '#section' })
  })
})
