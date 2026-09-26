// The tree's file glyphs carry the type's own mark, and that mark has to be readable at the size the
// tree renders them: at 14px with a 5px label the letters were a smudge.
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

  it('sets the type mark at a size that stays inside the plate', () => {
    const label = ruleBody('.workspace-tree-glyph-icon.file-glyph-icon .file-glyph-label')
    expect(label).toContain('font-size: 7px')
    expect(label).toContain('font-weight: 800')
    // Wide letterforms step down one size; both sizes are integers, so the font renders as designed.
    const narrow = ruleBody(
      '.workspace-tree-glyph-icon.file-glyph-icon .file-glyph-label-markdown,\n'
      + '.workspace-tree-glyph-icon.file-glyph-icon .file-glyph-label-pdf,\n'
      + '.workspace-tree-glyph-icon.file-glyph-icon .file-glyph-label-database,\n'
      + '.workspace-tree-glyph-icon.file-glyph-icon .file-glyph-label-git',
    )
    expect(narrow).toContain('font-size: 6px')
  })
})
