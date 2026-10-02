// File glyph boxes and the neutral outlines must remain readable in a dense tree.
import { describe, expect, it } from 'vitest'
import { readRendererStyleSource } from './style-source-test-utils'

const styles = await readRendererStyleSource()

function ruleBody(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start, `${selector} must exist`).toBeGreaterThan(-1)
  const end = styles.indexOf('}', start)
  return styles.slice(start, end)
}

describe('workspace tree glyph legibility', () => {
  it('draws the glyph at the full column width', () => {
    expect(ruleBody('.workspace-tree-glyph-icon')).toContain('width: 16px')
    expect(ruleBody('.workspace-tree-glyph-icon')).toContain('height: 16px')
  })

  it('keeps neutral files and folders outlined without overriding the imported format marks', () => {
    const sheet = ruleBody('.workspace-tree-glyph-icon.file-glyph-icon .file-glyph-sheet,\n'
      + '.workspace-tree-glyph-icon.file-glyph-icon .file-glyph-fold')
    expect(sheet).toContain('fill: none')
    expect(sheet).toContain('stroke-width: 1.2')
    const folder = ruleBody('.workspace-tree-glyph-icon.folder-glyph-icon .folder-glyph-body')
    expect(folder).toContain('currentColor 10%, transparent')
    expect(folder).toContain('stroke-width: 1.2')
    expect(styles).not.toContain('.file-glyph-label')
    expect(styles).not.toMatch(/\.file-glyph-format-mark\s*\{[^}]*(?:filter|opacity)/u)
  })
})
