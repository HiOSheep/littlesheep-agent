import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { shouldReturnMenuCaret, type MenuCaretAfterClose } from './menu-focus-return'

describe('the caret a closing composer menu gives back', () => {
  const held = (caretAfterClose: MenuCaretAfterClose) => ({ caretHeldByMenu: true, caretAfterClose })

  it('gives it back when the close dropped it on the page body', () => {
    // Measured before the fix: every composer menu closed by making its panel
    // `inert`, so the caret ended on `document.body` and the next keystroke
    // reached nothing.
    expect(shouldReturnMenuCaret(held('body'))).toBe(true)
  })

  it('gives it back when the browser has not run its caret fix-up yet', () => {
    // `inert` is committed by React; the browser empties the caret on its next
    // rendering opportunity. The effect can legitimately see either state.
    expect(shouldReturnMenuCaret(held('menu'))).toBe(true)
  })

  it('leaves a caret alone that an outside click moved somewhere real', () => {
    expect(shouldReturnMenuCaret(held('elsewhere'))).toBe(false)
  })

  it('leaves the composer caret alone when the menu never held it', () => {
    // A popover never takes the caret when it opens, so a menu that was opened
    // and closed while the user was typing must not move it either.
    for (const caretAfterClose of ['menu', 'body', 'elsewhere'] as const) {
      expect(shouldReturnMenuCaret({ caretHeldByMenu: false, caretAfterClose })).toBe(false)
    }
  })
})

/** The body of a top-level `function <name>() { ... }`, so order inside it can be asserted. */
function functionBody(source: string, name: string): string | null {
  const start = source.indexOf(`function ${name}()`)
  if (start < 0) return null
  const open = source.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return null
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1
}

const MENUS = [
  {
    name: 'add menu',
    path: './add-menu.tsx',
    closeFunction: 'closeMenu',
    hookCall: 'useMenuFocusReturn({ open, panelRef, triggerRef })',
    panelRefInJsx: 'ref={panelRef}',
  },
  {
    name: 'permission menu',
    path: './mode-picker.tsx',
    closeFunction: 'closeMenu',
    hookCall: 'useMenuFocusReturn({ open, panelRef, triggerRef })',
    panelRefInJsx: 'ref={panelRef}',
  },
  {
    name: 'model menu',
    path: './runtime-picker.tsx',
    closeFunction: 'closePicker',
    hookCall: 'useMenuFocusReturn({ open, panelRef: menuShellRef, triggerRef })',
    panelRefInJsx: 'ref={menuShellRef}',
  },
]

describe('composer menu close wiring', () => {
  for (const menu of MENUS) {
    it(`sends every close of the ${menu.name} through the one path that returns the caret`, async () => {
      const source = await readFile(new URL(menu.path, import.meta.url), 'utf8')

      expect(source, 'the menu must use the shared caret rule').toContain("from './menu-focus-return'")
      expect(source, 'the rule must be wired to a panel and the trigger').toContain(menu.hookCall)
      expect(source, 'the popup must be the element the caret position is measured against')
        .toContain(menu.panelRefInJsx)
      expect(source, 'the trigger must be the element that gets the caret back').toContain('ref={triggerRef}')

      // One close path, and it is the one that captures the caret. A second
      // `setOpen(false)` anywhere is a second way for the menu to disappear, and
      // that one would drop the caret on the body again.
      expect(occurrences(source, 'setOpen(false)'), 'the menu must have exactly one close path').toBe(1)
      const body = functionBody(source, menu.closeFunction)
      expect(body, `${menu.closeFunction} is missing`).not.toBeNull()
      expect(body, 'the close path must capture the caret before it closes').toContain('captureMenuCaret()')
      expect(
        body!.indexOf('captureMenuCaret()'),
        'the caret has to be read while the menu is still rendered',
      ).toBeLessThan(body!.indexOf('setOpen(false)'))
    })
  }
})
