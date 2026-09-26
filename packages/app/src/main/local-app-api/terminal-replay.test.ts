// UX-37: a replay must not make the surface answer terminal device queries a second time.
import { describe, expect, it } from 'vitest'
import { stripTerminalDeviceQueries } from './terminal-session'

describe('terminal replay filtering', () => {
  it('drops the queries a terminal answers by itself', () => {
    // Measured: PowerShell received `\x1b[?1;2cSet-Content …` and reported `[` 后面缺少…, so the
    // user's own next command was rejected for a line they never typed that way.
    expect(stripTerminalDeviceQueries('\x1b[c\x1b[>c\x1b[5n\x1b[6n')).toBe('')
    expect(stripTerminalDeviceQueries('PS> \x1b[cSet-Content -LiteralPath .\\a.txt'))
      .toBe('PS> Set-Content -LiteralPath .\\a.txt')
  })

  it('keeps every byte of ordinary output, including other escapes', () => {
    const output = '\x1b[32mPASS\x1b[0m\r\n\x1b]0;title\x07done'
    expect(stripTerminalDeviceQueries(output)).toBe(output)
    // A cursor-position *report* is not a query, and colour codes are not touched.
    expect(stripTerminalDeviceQueries('\x1b[10;20R')).toBe('\x1b[10;20R')
  })
})
