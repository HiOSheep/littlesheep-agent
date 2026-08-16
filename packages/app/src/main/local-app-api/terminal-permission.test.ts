import { describe, expect, it } from 'vitest'
import { assertTerminalOperationAllowed } from './terminal-permission.js'

const containerRoot = 'C:\\LS-data'
const inside = 'C:\\LS-data\\workplace'
const outside = 'C:\\Users\\Public\\project'

describe('terminal operation authority', () => {
  it('allows the user-owned workspace terminal without consulting Agent permission mode', () => {
    expect(() => assertTerminalOperationAllowed({
      source: 'workspace-user',
    })).not.toThrow()
  })

  it('allows Agent commands in full mode inside the LS container', () => {
    expect(() => assertTerminalOperationAllowed({
      source: 'agent',
      command: 'Get-ChildItem',
      cwd: inside,
      containerRoot,
      permissionMode: 'full',
      approved: false,
    })).not.toThrow()
  })

  it('allows Agent commands in full mode outside the container without per-operation approval', () => {
    expect(() => assertTerminalOperationAllowed({
      source: 'agent',
      command: 'Get-ChildItem',
      cwd: outside,
      containerRoot,
      permissionMode: 'full',
      approved: false,
    })).not.toThrow()
    expect(() => assertTerminalOperationAllowed({
      source: 'agent',
      command: 'Get-Content $HOME\\secret.txt',
      cwd: outside,
      containerRoot,
      permissionMode: 'full',
      approved: false,
    })).not.toThrow()
  })

  it('continues to require approval for Agent commands in research and restricted modes', () => {
    expect(() => assertTerminalOperationAllowed({
      source: 'agent',
      command: 'Get-ChildItem',
      cwd: inside,
      containerRoot,
      permissionMode: 'research',
      approved: false,
    })).toThrow()
    expect(() => assertTerminalOperationAllowed({
      source: 'agent',
      command: 'Get-ChildItem',
      cwd: inside,
      containerRoot,
      permissionMode: 'research',
      approved: true,
    })).not.toThrow()
    expect(() => assertTerminalOperationAllowed({
      source: 'agent',
      command: 'Get-ChildItem',
      cwd: inside,
      containerRoot,
      permissionMode: 'restricted',
      approved: false,
    })).toThrow()
  })
})
