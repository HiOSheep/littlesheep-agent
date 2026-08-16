import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  writeWorkspaceTerminalInput: vi.fn(),
}))

vi.mock('../api', () => apiMocks)

import { createTerminalInputController } from './terminal-input-controller'

describe('workspace user terminal input', () => {
  beforeEach(() => {
    apiMocks.writeWorkspaceTerminalInput.mockReset()
  })

  it('forwards a completed command once without permission or approval fields', async () => {
    apiMocks.writeWorkspaceTerminalInput.mockResolvedValue({ completed: 1 })
    const statuses: string[] = []
    const onCompletedCommand = vi.fn()
    const controller = createTerminalInputController({
      getTerminalSessionId: () => 'terminal-1',
      getAppSessionId: () => 'conversation-1',
      isDisposed: () => false,
      writeLine: vi.fn(),
      setStatus: (status) => statuses.push(status),
      onCompletedCommand,
    })

    controller.queue('Get-Date\r')
    await controller.drain()

    expect(apiMocks.writeWorkspaceTerminalInput).toHaveBeenCalledTimes(1)
    expect(apiMocks.writeWorkspaceTerminalInput).toHaveBeenCalledWith(
      'terminal-1',
      'Get-Date\r',
      'conversation-1',
    )
    expect(statuses).toEqual(['PowerShell 就绪'])
    expect(onCompletedCommand).toHaveBeenCalledTimes(1)
  })

  it('reports transport errors directly instead of opening an approval flow', async () => {
    apiMocks.writeWorkspaceTerminalInput.mockRejectedValue(
      Object.assign(new Error('terminal transport failed'), { status: 403 }),
    )
    const writeLine = vi.fn()
    const statuses: string[] = []
    const controller = createTerminalInputController({
      getTerminalSessionId: () => 'terminal-1',
      getAppSessionId: () => undefined,
      isDisposed: () => false,
      writeLine,
      setStatus: (status) => statuses.push(status),
      onCompletedCommand: vi.fn(),
    })

    controller.queue('Get-Date\r')
    await controller.drain()

    expect(apiMocks.writeWorkspaceTerminalInput).toHaveBeenCalledTimes(1)
    expect(writeLine).toHaveBeenCalledWith('\x1b[31mterminal transport failed\x1b[0m')
    expect(statuses).toEqual(['输入失败'])
  })
})
