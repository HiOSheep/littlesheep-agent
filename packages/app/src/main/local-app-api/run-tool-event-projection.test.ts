import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { ToolStreamEvent } from '@littlesheep/types'
import { MAX_SSE_BUFFERED_BYTES } from './http.js'
import { projectToolEventForStream, writeToolEventSse } from './run-tool-event-projection.js'

describe('projectToolEventForStream', () => {
  it('bounds a large file write without losing its path or line count', () => {
    const content = Array.from({ length: 8_000 }, (_, index) => `line ${index}`).join('\n')
    const projected = projectToolEventForStream({
      type: 'tool_start', callId: 'write-1', name: 'write',
      input: { file_path: 'src/example.ts', content },
    })
    expect(projected.input).toEqual({ file_path: 'src/example.ts', truncated: true })
    expect(projected.lineProgress).toEqual({ additions: 8_000, deletions: null })
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8')).toBeLessThan(32 * 1024)
  })

  it('leaves small events intact', () => {
    const event = { type: 'tool_start' as const, callId: 'read-1', name: 'read', input: { file_path: 'README.md' } }
    expect(projectToolEventForStream(event)).toBe(event)
  })

  it('writes the same bounded tool projection through the shared SSE backpressure gate', () => {
    const response = new FakeResponse()
    const event: ToolStreamEvent = {
      type: 'tool_start',
      callId: 'write-large',
      name: 'write',
      input: { file_path: 'src/large.ts', content: 'line\n'.repeat(8_000) },
    }

    expect(writeToolEventSse(response as unknown as ServerResponse, event)).toBe(true)
    const frame = response.writes[0]!
    expect(Buffer.byteLength(frame, 'utf8')).toBeLessThan(32 * 1024)
    const payload = JSON.parse(frame.split('data: ')[1]!.trim()) as ToolStreamEvent
    expect(payload.input).toEqual({ file_path: 'src/large.ts', truncated: true })
    expect(payload.lineProgress).toEqual({ additions: 8_000, deletions: null })

    response.writableLength = MAX_SSE_BUFFERED_BYTES
    expect(writeToolEventSse(response as unknown as ServerResponse, event)).toBe(false)
    expect(response.destroyed).toBe(true)
  })
})

class FakeResponse extends EventEmitter {
  destroyed = false
  writableEnded = false
  writableLength = 0
  writes: string[] = []

  destroy(): this {
    this.destroyed = true
    return this
  }

  write(value: string): boolean {
    this.writes.push(value)
    return true
  }
}
