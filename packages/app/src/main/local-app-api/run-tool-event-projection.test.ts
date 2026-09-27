import { describe, expect, it } from 'vitest'
import { projectToolEventForStream } from './run-tool-event-projection.js'

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
})
