import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_SSE_BUFFERED_BYTES, openSse, writeSse } from './http.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('Local App API SSE primitives', () => {
  it('emits bounded heartbeats and releases the timer when the response closes', () => {
    vi.useFakeTimers()
    const response = new FakeResponse()
    const cleanup = openSse(response as unknown as ServerResponse, 1_000)

    expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream; charset=utf-8',
    }))
    vi.advanceTimersByTime(2_000)
    expect(response.writes).toEqual([': heartbeat\n\n', ': heartbeat\n\n'])

    response.emit('close')
    vi.advanceTimersByTime(5_000)
    expect(response.writes).toHaveLength(2)
    expect(() => cleanup()).not.toThrow()
  })

  it('does not write events into a destroyed response', () => {
    const response = new FakeResponse()
    response.destroyed = true
    expect(writeSse(response as unknown as ServerResponse, 'result', { ok: true })).toBe(false)
    expect(response.writes).toEqual([])
  })

  it('drops a stalled observer before its SSE buffer can grow without bound', () => {
    const response = new FakeResponse()
    response.writableLength = MAX_SSE_BUFFERED_BYTES

    expect(writeSse(response as unknown as ServerResponse, 'delta', { text: 'more' })).toBe(false)
    expect(response.destroy).toHaveBeenCalledOnce()
    expect(response.writes).toEqual([])
  })

  it('keeps the stream alive when Node reports ordinary write backpressure below the cap', () => {
    const response = new FakeResponse()
    response.writeResult = false

    expect(writeSse(response as unknown as ServerResponse, 'delta', { text: 'queued' })).toBe(true)
    expect(response.destroy).not.toHaveBeenCalled()
    expect(response.writes).toHaveLength(1)
  })

  it('swallows a synchronous write race after the response closes', () => {
    const response = new FakeResponse()
    response.throwOnWrite = true

    expect(() => writeSse(response as unknown as ServerResponse, 'delta', { text: 'late' })).not.toThrow()
    expect(writeSse(response as unknown as ServerResponse, 'delta', { text: 'later' })).toBe(false)
  })

  it('handles an asynchronous response error without throwing from the process', () => {
    const response = new FakeResponse()
    expect(writeSse(response as unknown as ServerResponse, 'delta', { text: 'queued' })).toBe(true)

    expect(() => response.emit('error', Object.assign(new Error('write EOP'), { code: 'EOP' }))).not.toThrow()
    expect(writeSse(response as unknown as ServerResponse, 'delta', { text: 'late' })).toBe(false)
  })
})

class FakeResponse extends EventEmitter {
  destroyed = false
  writableEnded = false
  writableLength = 0
  writeResult = true
  throwOnWrite = false
  writes: string[] = []
  writeHead = vi.fn()
  flushHeaders = vi.fn()
  destroy = vi.fn(() => {
    this.destroyed = true
    this.emit('close')
    return this
  })

  write(value: string): boolean {
    if (this.throwOnWrite) throw new Error('write EOP')
    this.writes.push(value)
    return this.writeResult
  }
}
