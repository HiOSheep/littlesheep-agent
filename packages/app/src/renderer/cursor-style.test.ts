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
    // The pointer is the ordinary action cursor. One surface is genuinely draggable — the floating
    // task pill, which can be moved anywhere inside the conversation (asked for 2026-10-03) — so
    // grab cursors are allowed on that bar and nowhere else.
    const grabRules = [...styles.matchAll(/([^{}]+)\{([^{}]*cursor:\s*(?:grab|grabbing)\b[^{}]*)\}/gu)]
    expect(grabRules.length).toBeGreaterThan(0)
    for (const rule of grabRules) {
      expect(rule[1], rule[1]?.trim()).toMatch(/\.running-pill\b/u)
    }
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
