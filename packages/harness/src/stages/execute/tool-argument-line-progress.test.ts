import { describe, expect, it } from 'vitest'
import { toolArgumentLineProgress, toolArgumentSummary } from './tool-argument-line-progress.js'

describe('streamed tool argument line progress', () => {
  it('counts a partial JSON string without emitting the source text', () => {
    expect(toolArgumentLineProgress('write', '{"file_path":"a.ts","content":"one\\ntwo'))
      .toEqual({ additions: 2, deletions: null })
  })

  it('counts both sides of an edit and handles escaped characters', () => {
    expect(toolArgumentLineProgress('edit', '{"old_string":"one\\ntwo","new_string":"one\\nthree"}'))
      .toEqual({ additions: 2, deletions: 2 })
  })

  it('does not infer file edits from command text', () => {
    expect(toolArgumentLineProgress('exec', '{"command":"echo +1 -1"}')).toBeNull()
  })

  it('shows a bounded target without exposing file content', () => {
    expect(toolArgumentSummary('{"file_path":"src/a.ts","content":"private body"}')).toBe('src/a.ts')
    expect(toolArgumentSummary('{"command":"rg --files')).toBe('rg --files')
  })
})
