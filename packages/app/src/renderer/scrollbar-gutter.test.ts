import { readRendererStyleSource } from './style-source-test-utils'
import { describe, expect, it } from 'vitest'

/**
 * Scroll stability (2026-10-02).
 *
 * A classic scrollbar takes layout space, so a scroller that gains one pushes its content sideways
 * and takes it back when the scrollbar goes: measured in the real window, the settings body moved
 * its page from x=380 to x=375 the moment one settings page grew past the viewport and the next one
 * did not. Every scroller therefore either reserves the gutter - `stable` for lists and panels,
 * `both-edges` where the content is centred (or where the scroller is a popup whose own padding would
 * otherwise look lopsided), so nothing shifts sideways - or declares that
 * it never shows a scrollbar (`scrollbar-width: none`), which is the one case where there is no
 * space to reserve. This file DERIVES the list from the stylesheet instead of naming it, so a new
 * scroller cannot arrive without answering the question.
 */
const styles = await readRendererStyleSource()

interface Rule {
  selector: string
  body: string
}

function rules(source: string): Rule[] {
  const withoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map((match) => ({ selector: (match[1] ?? '').replaceAll(/\s+/gu, ' ').trim(), body: match[2] ?? '' }))
    .filter(({ selector }) => selector.length > 0 && !selector.startsWith('@'))
}

/** The block-axis overflow a rule ends up with: the last declaration in the body wins. */
function scrolls(body: string): boolean {
  const declarations = [...body.matchAll(/overflow(?:-y)?:\s*([a-z]+)/gu)]
  const last = declarations.at(-1)?.[1]
  return last === 'auto' || last === 'scroll'
}

const scrollers = rules(styles).filter((rule) => scrolls(rule.body))

/**
 * The runtime picker is the one scroller that must not reserve a gutter: its width is measured in
 * the DOM and written back as `--runtime-submenu-width`, and `composer/runtime-picker.test.ts`
 * forbids the gutter there so the measured width and the painted width stay the same number. It is
 * a popover anchored to the control that opened it, so the scrollbar it may gain moves nothing
 * behind it - unlike a page-level scroller, which is what the reader sees move.
 */
const GUTTER_EXEMPT = /\.runtime-menu-shell/u

describe('scroll stability', () => {
  it('has scrollers to check, so this contract cannot pass by finding nothing', () => {
    expect(scrollers.length).toBeGreaterThan(30)
  })

  it('reserves a gutter in every scroller that can gain a scrollbar', () => {
    const unreserved = scrollers
      .filter((rule) => !GUTTER_EXEMPT.test(rule.selector))
      .filter((rule) => !/scrollbar-gutter:/u.test(rule.body) && !/scrollbar-width:\s*none/u.test(rule.body))
      .map((rule) => rule.selector)
    expect(unreserved).toEqual([])
  })

  it('keeps a centred page centred while reserving it', () => {
    // `both-edges` is what keeps a centred page's centre: one gutter would move it half a scrollbar
    // to the side permanently, which is the same defect wearing a smaller number.
    for (const selector of ['.settings-workspace-body', '.direct-module-workspace', '.workspace-panel-view']) {
      expect(styles).toMatch(new RegExp(`\\${selector}\\s*\\{[^}]*scrollbar-gutter:\\s*stable both-edges;`, 'u'))
    }
  })

  it('keeps the transcript and both sidebar lists symmetric, where they already reserved space', () => {
    for (const selector of ['.messages', '.session-list', '.project-tree']) {
      expect(styles).toMatch(new RegExp(`\\${selector}\\s*\\{[^}]*scrollbar-gutter:\\s*stable both-edges;`, 'u'))
    }
    expect(styles).toMatch(/\.workspace-tree\s*\{[^}]*scrollbar-gutter:\s*stable;/u)
  })

  it('keeps a floating menu\'s own padding symmetric', () => {
    // A reserved gutter first sat on the end side only, then on both: either way the rows' side insets
    // (17.7px) came out wider than their top and bottom ones (7px) and the list lost 10px of width
    // (reported 2026-10-03). A short popup hides its scrollbar instead, so the rows keep one 7px inset
    // all round and the row box is as wide as the menu allows.
    expect(styles).toMatch(/\.split-button-menu\s*\{[^}]*scrollbar-width:\s*none;/u)
    expect(styles).not.toMatch(/\.split-button-menu\s*\{[^}]*scrollbar-gutter:/u)
  })
})
