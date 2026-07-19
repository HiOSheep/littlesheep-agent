import { describe, expect, it } from 'vitest'
import {
  analyzeTerminalInput,
  EMPTY_TERMINAL_INPUT_STATE,
} from './terminal-input.js'

describe('interactive terminal input tracking', () => {
  it('recognizes a command split across raw input requests', () => {
    const first = analyzeTerminalInput(EMPTY_TERMINAL_INPUT_STATE, 'Get-ChildItem')
    expect(first.commands).toEqual([])

    const second = analyzeTerminalInput(first.nextState, '\r\n')
    expect(second.commands).toEqual([{ command: 'Get-ChildItem', uncertain: false }])
    expect(second.nextState).toEqual(EMPTY_TERMINAL_INPUT_STATE)
  })

  it('tracks backspace and common line-editing controls', () => {
    const result = analyzeTerminalInput(EMPTY_TERMINAL_INPUT_STATE, 'Get-ChildItem\x08\x15Write-Output\r')
    expect(result.commands).toEqual([{ command: 'Write-Output', uncertain: false }])
  })

  it('fails closed after an escape sequence that may replace the shell line', () => {
    const result = analyzeTerminalInput(EMPTY_TERMINAL_INPUT_STATE, '\x1b[AGet-ChildItem\r')
    expect(result.commands).toEqual([{ command: 'Get-ChildItem', uncertain: true }])
  })

  it('handles multiple pasted lines and does not create a second command for CRLF', () => {
    const result = analyzeTerminalInput(EMPTY_TERMINAL_INPUT_STATE, 'pwd\r\nGet-Date\n')
    expect(result.commands).toEqual([
      { command: 'pwd', uncertain: false },
      { command: 'Get-Date', uncertain: false },
    ])
  })
})
