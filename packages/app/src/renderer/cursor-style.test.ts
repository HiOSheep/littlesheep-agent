import { describe, expect, it } from 'vitest'
import { readRendererStyleSource } from './style-source-test-utils'


const styles = await readRendererStyleSource()


function selectorDeclares(selector: string, declaration: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const rules = [...styles.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gu'))]
  return rules.some((rule) => rule[1]?.includes(declaration))
}


describe('renderer cursor policy', () => {
  it('gives ordinary interactive controls the pointer', () => {
    const ordinaryControlRule = styles.match(/button,[\s\S]*?\[role='tab'\]\s*\{([^}]*)\}/u)?.[1] ?? ''

    expect(ordinaryControlRule).toContain('cursor: pointer;')
    // The pointer is the ordinary action cursor; grab-style cursors stay out of
    // the renderer because nothing here is a draggable surface.
    expect(styles).not.toMatch(/cursor:\s*(?:grab|grabbing)\b/u)
  })

  it('reserves the resize cursor for the four custom-width handles', () => {
    for (const selector of [
      '.sidebar-resizer',
      '.workspace-panel-resizer',
      '.workspace-files-navigator-resizer',
      '.settings-sidebar-resizer',
    ]) {
      expect(selectorDeclares(selector, 'cursor: col-resize;'), selector).toBe(true)
    }

    expect(styles).toMatch(
      /body\.is-resizing-column,\s*body\.is-resizing-column \*\s*\{[^}]*cursor:\s*col-resize !important;/u,
    )
    expect(selectorDeclares('.session-item.renaming', 'cursor: text;')).toBe(true)
  })
})
