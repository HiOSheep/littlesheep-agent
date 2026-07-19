import { describe, expect, it } from 'vitest'
import {
  assertTerminalCommandAllowed,
  assertTerminalSessionAllowed,
} from './terminal-permission.js'

const containerRoot = 'C:\\LS-data'
const inside = 'C:\\LS-data\\workplace'
const outside = 'C:\\Users\\Public\\project'

describe('terminal permission boundary', () => {
  it('allows full mode to start and use a terminal inside the LS container', () => {
    expect(() => assertTerminalSessionAllowed({
      cwd: inside,
      containerRoot,
      permissionMode: 'full',
      approved: false,
    })).not.toThrow()
    expect(() => assertTerminalCommandAllowed({
      command: 'Get-ChildItem',
      cwd: inside,
      containerRoot,
      permissionMode: 'full',
      approved: false,
    })).not.toThrow()
  })

  it('requires approval for a full-mode terminal outside the container', () => {
    expect(() => assertTerminalSessionAllowed({
      cwd: outside,
      containerRoot,
      permissionMode: 'full',
      approved: false,
    })).toThrow(/需要用户批准/u)
    expect(() => assertTerminalCommandAllowed({
      command: 'Get-ChildItem',
      cwd: outside,
      containerRoot,
      permissionMode: 'full',
      approved: false,
    })).toThrow(/需要用户批准/u)
    expect(() => assertTerminalSessionAllowed({
      cwd: outside,
      containerRoot,
      permissionMode: 'full',
      approved: true,
    })).not.toThrow()
  })

  it('requires approval for research execution and restricted reads', () => {
    expect(() => assertTerminalSessionAllowed({
      cwd: inside,
      containerRoot,
      permissionMode: 'research',
      approved: false,
    })).toThrow()
    expect(() => assertTerminalCommandAllowed({
      command: 'Get-ChildItem',
      cwd: inside,
      containerRoot,
      permissionMode: 'research',
      approved: false,
    })).toThrow()
    expect(() => assertTerminalCommandAllowed({
      command: 'Get-ChildItem',
      cwd: inside,
      containerRoot,
      permissionMode: 'research',
      approved: true,
    })).not.toThrow()
    expect(() => assertTerminalSessionAllowed({
      cwd: inside,
      containerRoot,
      permissionMode: 'restricted',
      approved: false,
    })).toThrow()
  })
})
