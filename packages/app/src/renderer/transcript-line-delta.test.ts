import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { vi } from 'vitest'
import { readRendererStyleSource } from './style-source-test-utils'
import { ToolLineDeltaBadge } from './chat/agent-tool-row'
import { countLines, patchDelta, toolLineDelta } from './chat/tool-line-delta'

const styles = await readRendererStyleSource()
vi.stubGlobal('React', React)

describe('line counts for a file-writing call', () => {
  it('counts what a write call will add, and admits it cannot count the old lines', () => {
    expect(toolLineDelta('write', { file_path: 'a.ts', content: 'one\ntwo\nthree\n' }))
      .toEqual({ additions: 3, deletions: null })
    expect(toolLineDelta('write_file', { file_path: 'a.ts', content: '' }))
      .toEqual({ additions: 0, deletions: null })
  })

  it('counts both sides of an edit', () => {
    expect(toolLineDelta('edit', { file_path: 'a.ts', old_string: 'one\ntwo', new_string: 'one\ntwo\nthree' }))
      .toEqual({ additions: 3, deletions: 2 })
    // A no-op edit has nothing to report.
    expect(toolLineDelta('edit', { old_string: 'same', new_string: 'same' })).toBeNull()
  })

  it('counts a patch by its own +/- lines', () => {
    const patch = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '-gone',
      '+added',
      '+also added',
    ].join('\n')
    expect(patchDelta(patch)).toEqual({ additions: 2, deletions: 1 })
    expect(toolLineDelta('apply_patch', { patch })).toEqual({ additions: 2, deletions: 1 })
  })

  it('reports nothing for a call that does not write a file', () => {
    expect(toolLineDelta('read', { file_path: 'a.ts' })).toBeNull()
    expect(toolLineDelta('exec', { command: 'echo +1 -1' })).toBeNull()
    expect(toolLineDelta('write', null)).toBeNull()
  })

  it('treats a trailing newline as a terminator', () => {
    expect(countLines('a\nb\n')).toBe(2)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('\n')).toBe(0)
    expect(countLines('')).toBe(0)
  })
})

describe('the transcript line-count badge', () => {
  const badge = (name: string, input: unknown, running = false) => renderToStaticMarkup(
    React.createElement(ToolLineDeltaBadge, { name, input, running }),
  )

  it('shows additions alone when the deletions are unknown', () => {
    const markup = badge('write', { content: 'a\nb\n' })
    expect(markup).toContain('agent-flow-delta-add')
    expect(markup).toContain('+2')
    expect(markup).not.toContain('agent-flow-delta-remove')
  })

  it('shows both sides for an edit and marks a live one', () => {
    const markup = badge('edit', { old_string: 'a', new_string: 'a\nb' }, true)
    expect(markup).toContain('+2')
    expect(markup).toContain('-1')
    expect(markup).toContain('is-live')
    expect(markup).toContain('仍在写入')
  })

  it('renders nothing for a call that does not write a file', () => {
    expect(badge('read', { file_path: 'a.ts' })).toBe('')
  })
})

describe('transcript count colours', () => {
  it('is always coloured here, unlike the artifact card', () => {
    const add = styles.slice(styles.indexOf('.agent-flow-delta-add {'), styles.indexOf('}', styles.indexOf('.agent-flow-delta-add {')))
    const remove = styles.slice(styles.indexOf('.agent-flow-delta-remove {'), styles.indexOf('}', styles.indexOf('.agent-flow-delta-remove {')))
    expect(add).toContain('color: var(--line-delta-add')
    expect(remove).toContain('color: var(--line-delta-remove')
    expect(styles).toContain('.agent-flow-delta.is-live {')
  })
})
