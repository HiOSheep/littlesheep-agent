import { readdir, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  drawsIndicator,
  findClipRisks,
  findFocusSuppressions,
  isFocusRule,
  parseStyleRules,
  subjectOf,
  subjectsOf,
  suppressesOutline,
  type StyleRule,
} from './focus-indicator-rules'
import { ENTRY_FOCUS_TIMEOUT_MS } from './focus-ownership'

/**
 * Rule R3, asserted over the renderer's stylesheets: a focused control must be
 * *visibly* focused - it shows a ring or a fill.
 *
 * `focus-ownership.ts` states the rule and owns the focus lifecycle it belongs
 * to. This file is where the stylesheet half of it can fail a build, and it
 * catches the two shapes the audit measured:
 *
 *   #19  `.settings-sidebar-search input:focus { outline: 0 }` turned the
 *        app-wide keyboard ring off and put nothing in its place: 0 ring pixels
 *        and 0 fill pixels for the field, against 2538 ring pixels for a rail
 *        item in the same window.
 *   the permission picker  the substitute *was* drawn, but `.option-picker-list`
 *        is a scrolling container with `overflow-x: hidden` and zero inline
 *        padding, so it clipped the focused option's left and right ring sides
 *        to 0.00 coverage.
 *
 * The pixel half of R3 lives in `scripts/lib/focus-visibility.mjs` and is
 * asserted by `scripts/verify-focus-ownership.mjs` in a real window, because a
 * rule can be present here and still be covered by another element.
 */

const STYLE_DIR = new URL('../styles/', import.meta.url)

/**
 * The controls whose own ring is redundant or absent, and the exact claim that
 * justifies it. Nothing is allowed to sit here on a bare reason string: a
 * `compensated` entry names the selector that draws the substitute for it, and
 * `verifies the claims the exception list makes` below checks that the named rule
 * really exists and really draws something.
 *
 * `key` is the selector path with its state pseudo-classes removed (`.composer
 * textarea:focus` -> `.composer textarea`). The path is required: the app has
 * many `input` and `textarea` elements, and keying on the bare tag would let one
 * field's ring excuse another field's.
 */
interface FocusException {
  key: string
  kind: 'compensated' | 'gap'
  /** A selector whose focus rule draws the visible substitute in this control's place. */
  compensatedBy?: string
  reason: string
}

/**
 * A surrounding surface draws the ring for the control inside it, so a second
 * ring on the child would be wrong.
 */
const COMPENSATED: FocusException[] = [
  {
    key: '.attachment-preview-open',
    kind: 'compensated',
    compensatedBy: '.attachment-preview-card:focus-within',
    reason: 'the card draws the ring for whichever control inside it holds focus',
  },
  {
    key: '.attachment-preview-remove',
    kind: 'compensated',
    compensatedBy: '.attachment-preview-card:focus-within',
    reason: 'the card draws the ring for whichever control inside it holds focus',
  },
]

/**
 * Rules that remove the keyboard ring and draw nothing in its place - found by
 * this file the first time it ran, not introduced by this change.
 *
 * They are recorded rather than silently allowlisted: each is a real keyboard
 * gap, and whether it is worth a change of its own is for the pixel gate in
 * `scripts/verify-focus-ownership.mjs` to decide. They are split by *why* they
 * are not being changed here, because "someone else owns that file" and "the
 * main input's focus appearance is a design decision" are different claims.
 */
const UNGUARDED_OUT_OF_SCOPE: FocusException[] = [
  { key: '.workspace-panel-corner-toggle', kind: 'gap', reason: '04-workspace.css turns the ring off with no substitute; that file belongs to the workspace panels' },
  { key: '.workspace-panel-reopen-target', kind: 'gap', reason: '04-workspace.css turns the ring off; the control only appears while the template is collapsed' },
  { key: '.workspace-line-comment-editor textarea', kind: 'gap', reason: '04-workspace.css turns the ring off on a text field; that file belongs to the workspace panels' },
  { key: '.trace-toggle', kind: 'gap', reason: '07-overlays-settings.css turns the ring off and only recolours the label' },
]

/**
 * Unguarded controls in files this change *could* reach, which are left alone on
 * purpose. Both are text fields whose editable surface is a borderless child of
 * a rounded shell, so framing the field itself would put a rectangle inside the
 * pill; the shell is what would have to take the ring, and that is a visual
 * change to the app's two most-used surfaces - out of scope for a change whose
 * brief is three focus defects and no redesign.
 */
const UNGUARDED_IN_REACH_BUT_VISUAL: FocusException[] = [
  { key: '.composer textarea', kind: 'gap', reason: 'the main input; the ring would have to go on the .composer shell, which is a visual change of its own' },
  { key: '.settings-module-search input', kind: 'gap', reason: 'same shape as the composer field: a borderless input inside a rounded shell' },
]

const NAMED_EXCEPTIONS: FocusException[] = [...COMPENSATED, ...UNGUARDED_OUT_OF_SCOPE, ...UNGUARDED_IN_REACH_BUT_VISUAL]

async function readStyleRules(): Promise<StyleRule[]> {
  const names = (await readdir(STYLE_DIR)).filter((name) => name.endsWith('.css')).sort()
  const rules: StyleRule[] = []
  for (const name of names) {
    const source = await readFile(new URL(name, STYLE_DIR), 'utf8')
    rules.push(...parseStyleRules(`./styles/${name}`, source))
  }
  return rules
}

const styleRules = await readStyleRules()

describe('focus ownership module', () => {
  it('states the bounded retry as a constant rather than an open-ended loop', () => {
    // The whole defect was "nothing retries"; the fix must not become "retries
    // forever", or a surface whose target never appears would keep stealing the
    // caret back from the user.
    expect(ENTRY_FOCUS_TIMEOUT_MS).toBeGreaterThan(0)
    expect(ENTRY_FOCUS_TIMEOUT_MS).toBeLessThanOrEqual(1000)
  })

  it('keeps the rule stated in one place, with both halves of it named', async () => {
    const source = await readFile(new URL('./focus-ownership.ts', import.meta.url), 'utf8')
    // R1: initial focus with bounded retry.
    expect(source).toContain('ENTRY_FOCUS_TIMEOUT_MS')
    expect(source).toContain('window.requestAnimationFrame(attempt)')
    // R2: restore on close, but only when the surface actually took focus; and
    // when the element that had it is gone, fall back to releasing focus instead
    // of leaving the caret on a detached node.
    expect(source).toContain('export function restoreFocusTo(')
    expect(source).toContain('export function releaseFocus(')
    expect(source).toContain('if (!restoreFocus || !tookFocus) return')
    expect(source).toContain('if (!restoreFocusTo(previouslyFocused)) releaseFocus()')
    // R3: the visible-indicator rule is owned here and delegated for measurement.
    expect(source).toContain('A focused control must be *visibly* focused')
    expect(source).toContain('focus-visibility.mjs')
  })
})

describe('a focused control is visibly focused (R3)', () => {
  it('never turns the outline off for a focus state without a visible substitute', () => {
    const documented = new Set(NAMED_EXCEPTIONS.map((entry) => entry.key))
    const unguarded = findFocusSuppressions(styleRules).filter((suppression) => suppression.substitutes.length === 0)
    // Nothing is filtered away before the comparison, so a newly unguarded control
    // appears here by name instead of being quietly absorbed into an allowlist.
    const undocumented = unguarded
      .filter((suppression) => !suppression.keys.some((key) => documented.has(key)))
      .map((suppression) => `${suppression.rule.file} :: ${suppression.rule.selector} (keys: ${suppression.keys.join(' | ')})`)
    expect(
      undocumented,
      'these rules remove the focus ring and draw nothing in its place: either give the control a '
      + 'visible substitute (a ring or a fill) or add it to NAMED_EXCEPTIONS with the reason',
    ).toEqual([])
  })

  it('keeps the inventory of unguarded rules from growing unnoticed', () => {
    // The inventory is compared as a *set of controls*, not as a count: one rule
    // can name two controls (`.attachment-preview-open:focus-visible,
    // .attachment-preview-remove:focus-visible` is one rule and two subjects), so
    // a count would be wrong in both directions. Adding a control to
    // `NAMED_EXCEPTIONS` to silence a finding is then a visible edit to this list,
    // in the same commit as the reason - which is the point of writing them down.
    const unguarded = findFocusSuppressions(styleRules).filter((suppression) => suppression.substitutes.length === 0)
    const unguardedKeys = [...new Set(unguarded.flatMap((suppression) => suppression.keys))].sort()
    expect(unguardedKeys).toEqual(NAMED_EXCEPTIONS.map((entry) => entry.key).sort())
    for (const key of unguardedKeys) {
      const entry = NAMED_EXCEPTIONS.find((candidate) => candidate.key === key)
      expect(entry, `${key} has no recorded reason`).toBeDefined()
      expect(entry!.reason.length, `${key} has no reason written down`).toBeGreaterThan(12)
    }
    // The inventory is only as good as its halves being stated apart.
    expect(UNGUARDED_OUT_OF_SCOPE.every((entry) => entry.kind === 'gap')).toBe(true)
    expect(UNGUARDED_IN_REACH_BUT_VISUAL.every((entry) => entry.kind === 'gap')).toBe(true)
    expect(COMPENSATED.every((entry) => entry.kind === 'compensated' && entry.compensatedBy)).toBe(true)
  })

  it('verifies the claims the exception list makes, instead of trusting them', () => {
    // A `compensated` entry claims another selector draws the substitute. Check the
    // claim against the stylesheets: the named rule has to exist, be a focus rule,
    // and actually paint something. An exception that stops being true fails here
    // rather than silently covering a control that lost its ring.
    for (const entry of NAMED_EXCEPTIONS.filter((candidate) => candidate.kind === 'compensated')) {
      const named = styleRules.filter((rule) => rule.selector.split(',').map((part) => part.trim()).includes(entry.compensatedBy!))
      expect(named.length, `${entry.key} claims ${entry.compensatedBy} draws its ring, but no such rule exists`).toBeGreaterThan(0)
      const substitute = named.find((rule) => isFocusRule(rule) && drawsIndicator(rule) && !suppressesOutline(rule))
      expect(
        substitute,
        `${entry.key} claims ${entry.compensatedBy} draws its ring, but that rule paints nothing`,
      ).toBeDefined()
    }
    // Once the claim above holds, the card's children are genuinely covered - which
    // is what makes them different from the three gaps below.
    const cardRing = styleRules.find((rule) => rule.selector === '.attachment-preview-card:focus-within')
    expect(cardRing, 'the attachment card no longer draws the ring its two children rely on').toBeDefined()
    expect(cardRing!.declarations.some((declaration) => declaration.property === 'outline' && declaration.value.startsWith('2px solid'))).toBe(true)
  })

  it('keeps the settings search field ring, which is the substitute for its own reset', () => {
    // #19's exact shape: this rule removes the ring for pointer focus...
    const reset = styleRules.find((rule) => rule.selector === '.settings-sidebar-search input:focus')
    expect(reset, 'the pointer-focus reset for the settings search field is gone').toBeDefined()
    // ...and the keyboard ring has to be drawn for the same control, with the
    // shared values, or the field is invisible to a keyboard user again.
    const ring = styleRules.find((rule) => rule.selector === '.settings-sidebar-search input:focus-visible')
    expect(ring, 'the settings search field has no visible focus ring').toBeDefined()
    expect(ring!.declarations.some((declaration) => declaration.property === 'outline' && declaration.value.startsWith('2px solid'))).toBe(true)
    expect(ring!.declarations.some((declaration) => declaration.property === 'outline-offset')).toBe(true)
  })

  it('does not let a scrolling container clip the focus ring of the controls inside it', () => {
    // The container -> controls relation is stated here because it is a DOM
    // fact, not something a stylesheet can derive.
    const descendants = {
      '.option-picker-list': ['.option-picker-option', '.model-option'],
    }
    const risks = findClipRisks(styleRules, descendants).map((risk) => ({
      file: risk.container.file,
      selector: risk.container.selector,
      clippedAxes: risk.clippedAxes,
      clearance: risk.clearance,
      offset: risk.offset,
    }))
    expect(
      risks,
      'a clipping container has less padding than the focus ring of the controls inside it asks for, '
      + 'so that side of the ring is cut away',
    ).toEqual([])
  })
})

describe('the stylesheet reading itself', () => {
  it('parses rules and declarations as CSS, not as text', () => {
    const [rule] = parseStyleRules('./x.css', '.a:focus-visible, .b { outline: 2px solid red; outline-offset: 2px }')
    expect(rule!.selector).toBe('.a:focus-visible, .b')
    expect(rule!.declarations).toEqual([
      { property: 'outline', value: '2px solid red' },
      { property: 'outline-offset', value: '2px' },
    ])
  })

  it('ignores at-rule preludes instead of reading them as selectors', () => {
    const rules = parseStyleRules('./x.css', '@media (max-width: 760px) { .a { color: red } }')
    expect(rules.map((rule) => rule.selector)).toEqual(['.a'])
  })

  it('reduces a selector to the control it targets', () => {
    expect(subjectOf('.a:hover:not(:disabled)')).toBe('.a')
    expect(subjectOf('.mode-picker-panel .model-option')).toBe('.model-option')
    expect(subjectOf('.strip')).toBe('.strip')
    // A class selector is part of the control's identity, not a state: the walk
    // stops at the first state pseudo-class instead of at the first colon-like
    // character. Getting this wrong is how `.strip.active` was once read as the
    // same control as `.strip-link`.
    expect(subjectOf('.strip.active')).toBe('.strip.active')
    expect(subjectOf('.workspace-files-icon-btn[aria-pressed="true"]')).toBe('.workspace-files-icon-btn')
    expect(subjectsOf('.alpha:hover, .beta:focus-visible .gamma')).toEqual(['.alpha', '.gamma'])
  })

  it('reads the outline resets and the indicators as the two different things they are', () => {
    const rules = parseStyleRules('./x.css', [
      '.a:focus { outline: 0 }',
      '.b:focus { outline: none }',
      '.c:focus-visible { outline-style: none }',
      '.d:focus { outline-width: 0 }',
      '.e:focus { outline: 2px solid rgba(226, 226, 226, 0.32) }',
      '.f:focus-visible { background: var(--control-hover) }',
      '.g:focus { color: var(--text-strong); background: transparent }',
      '.h:focus { outline: none; background: var(--control-hover) }',
    ].join('\n'))
    const bySelector = new Map(rules.map((rule) => [rule.selector, rule]))
    const resets = findFocusSuppressions(rules).map((suppression) => suppression.rule.selector)
    expect(resets).toContain('.a:focus')
    expect(resets).toContain('.b:focus')
    expect(resets).toContain('.c:focus-visible')
    expect(resets).toContain('.d:focus')
    expect(resets).not.toContain('.e:focus')
    // A fill is an indication in its own right, so a rule that turns the outline
    // off *and* paints one is not a suppression at all.
    expect(resets).not.toContain('.h:focus')
    // A substitute has to be a focus rule *for the same control*. `.a:focus`
    // loses its ring; `.a:focus-visible` gives it a keyboard fill, so the pair is
    // compensated - while a `:hover`-only fill (or a fill for a different
    // control) would not count. That is what keeps "the pointer can see it" from
    // standing in for "Tab can see it".
    const paired = findFocusSuppressions(parseStyleRules('./x.css', [
      '.a:focus { outline: none }',
      '.a:focus-visible { background: var(--control-hover) }',
    ].join('\n')))
    expect(paired).toHaveLength(1)
    expect(paired[0]!.substitutes.map((rule) => rule.selector)).toEqual(['.a:focus-visible'])
    const wrongControl = findFocusSuppressions(parseStyleRules('./x.css', [
      '.a:focus { outline: none }',
      '.b:focus-visible { background: var(--control-hover) }',
    ].join('\n')))
    expect(wrongControl[0]!.substitutes).toEqual([])
    const hoverOnly = findFocusSuppressions(parseStyleRules('./x.css', [
      '.a:focus { outline: none }',
      '.a:hover { background: var(--control-hover) }',
    ].join('\n')))
    expect(hoverOnly[0]!.substitutes).toEqual([])
    // Colour alone is not an indication: a rule that only recolours text leaves a
    // keyboard user unable to see *where* the control is.
    expect(bySelector.get('.g:focus')!.declarations.length).toBe(2)
    expect(findFocusSuppressions(parseStyleRules('./x.css', '.g:focus { outline: none; color: red }'))[0]!.substitutes).toEqual([])
  })
})
