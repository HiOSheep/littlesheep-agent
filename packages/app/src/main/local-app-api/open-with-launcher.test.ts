import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { spawn } from 'node:child_process'
import { launchOpenWith } from './open-with-launcher.js'

describe('open-with application launch', () => {
  beforeEach(() => vi.resetAllMocks())

  it('reports a missing registered executable instead of publishing success or throwing an unhandled error', async () => {
    const child = new EventEmitter()
    vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>)
    const result = launchOpenWith('missing.exe', ['file.txt'])
    const rejected = expect(result).rejects.toMatchObject({ status: 500, message: '无法启动所选应用：ENOENT' })
    child.emit('error', new Error('ENOENT'))
    await rejected
  })

  it('waits until the application starts, then detaches without waiting for its exit', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
    let completed = false
    const result = launchOpenWith('editor.exe', ['file.txt']).then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    child.emit('spawn')
    await result
    expect(child.unref).toHaveBeenCalledOnce()
    expect(completed).toBe(true)
  })
})
