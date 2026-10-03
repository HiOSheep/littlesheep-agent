import { readRendererStyleSource } from './style-source-test-utils'
import { describe, expect, it } from 'vitest'

/**
 * Guards the app's corner geometry: every rounded surface is drawn as a
 * superellipse by the engine, and the shapes that must not be redrawn that way
 * are exempt in exactly one place.
 *
 * The exclusion list is *derived* here rather than trusted, because the failure
 * mode is silent: a new capsule or dot declares `border-radius:
 * var(--radius-circle)` in its own domain file, the blanket rule reaches it,
 * and the circle quietly becomes a rounded square.
 */

const styles = await readRendererStyleSource()

const CAPSULE_RADII = ['var(--radius-circle)', 'var(--radius-pill)']

interface Rule {
  selector: string
  body: string
}

/** Every `selector { … }` pair, with comments removed first. */
function rules(source: string): Rule[] {
  const withoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map((match) => ({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' }))
    .filter(({ selector }) => selector.length > 0 && !selector.startsWith('@'))
}

/** Selectors whose corner radius makes them a capsule or a circle. */
function capsuleRadii(source: string): { elements: Set<string>; pseudoElements: Set<string> } {
  const elements = new Set<string>()
  const pseudoElements = new Set<string>()
  const pattern = new RegExp(`border-radius:\\s*(?:${CAPSULE_RADII.map((v) => v.replaceAll(/[()]/gu, '\\$&')).join('|')});`, 'u')
  for (const { selector, body } of rules(source)) {
    if (!pattern.test(body)) continue
    for (const part of selector.split(',')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      if (trimmed.includes('::')) pseudoElements.add(trimmed)
      else elements.add(trimmed)
    }
  }
  return { elements, pseudoElements }
}

/** Rules that set the `corner-shape` property (not the `--corner-shape` token). */
function cornerShapeRules(source: string): Rule[] {
  return rules(source).filter(({ body }) => /(?<![\w-])corner-shape\s*:/u.test(body))
}

describe('corner shape', () => {
  const shaped = cornerShapeRules(styles)

  it('draws corners as a superellipse through the engine property, not a mask', () => {
    // `mask-image: paint(…)` clipped the element's own shadow, fought
    // `backdrop-filter`, and hid the element outright while the worklet was
    // unregistered. `corner-shape` is native from Chromium 139.
    //
    // 1.5 is a look decision, not a default: `superellipse(1)` is an ordinary
    // round corner and `superellipse(2)` the classic squircle, and at the same
    // `border-radius` the squircle gives up only 6.9% of the radius x radius
    // corner box where an arc gives up 21.5% (measured on Chromium 152), so it
    // read as barely more than half the radius the tokens ask for.
    expect(styles).toContain('--corner-shape: superellipse(1.5);')
    // Pinned as a family, not just as a literal: `round` would leave the
    // property supported and every assertion in this file green while the
    // continuous corner was silently gone, and `bevel`, `scoop`, `notch` and
    // `square` are different corners entirely.
    expect(styles).toMatch(/--corner-shape:\s*superellipse\([\d.]+\);/u)
    // `00-reset.css` also has a `*` rule, so match the one that carries the shape.
    const blanket = shaped.filter(({ selector, body }) => selector === '*' && body.includes('corner-shape: var(--corner-shape)'))
    expect(blanket).toHaveLength(1)
  })

  it('reaches elements only, so pseudo-elements keep their round corners', () => {
    // The scrollbar parts and the UI's chrome pseudo-elements are the shapes
    // most likely to be a dot or a capsule, so the blanket rule must not be
    // widened to `*::before, *::after`.
    const blanket = shaped.filter(({ body }) => body.includes('corner-shape: var(--corner-shape)'))
    expect(blanket.map(({ selector }) => selector)).toContain('*')
    for (const { selector } of shaped) {
      for (const part of selector.split(',')) {
        expect(part.trim().includes('*'), `unexpected wildcard selector: ${part.trim()}`).toBe(part.trim() === '*')
      }
    }
  })

  it('exempts exactly the capsules and circles, derived from the stylesheets', () => {
    // Two rules carry `corner-shape: round` — this exemption list and the beta
    // window layout's junction corner — so the exemption is identified by its own
    // membership (the capsule list leads with `.active-run-indicator`) instead of by
    // being whichever such rule the import order happens to reach first.
    const exemptions = shaped.filter(({ body }) => body.includes('corner-shape: round'))
    const exemption = exemptions.find(({ selector }) => selector.split(',').some((part) => part.trim() === '.active-run-indicator'))
    expect(exemption, 'no rule restores round corners for the capsules and circles').toBeDefined()
    const exempt = new Set(exemption!.selector.split(',').map((part) => part.trim()).filter(Boolean))
    const { elements, pseudoElements } = capsuleRadii(styles)

    // Not vacuous: the app really does have capsules and circles to exempt.
    expect(elements.size).toBeGreaterThan(0)
    expect(pseudoElements.size).toBeGreaterThan(0)

    // Exact set equality in both directions: a capsule missing from the list is
    // a circle about to be squared off, and a stale entry is a promise that no
    // longer holds.
    expect([...exempt].sort()).toEqual([...elements].sort())

    // Pseudo-elements are absent from the list on purpose — the blanket rule
    // cannot reach them, so listing them would be noise.
    for (const selector of pseudoElements) expect(exempt.has(selector)).toBe(false)

    // A capsule must never be exempted through some other rule: the beta layout
    // rounds two panel elements and nothing else.
    const beta = exemptions.filter(({ selector }) => selector.includes("data-window-layout='beta'"))
    expect(beta).toHaveLength(1)
    for (const { selector } of beta) {
      for (const part of selector.split(',')) {
        expect(exempt.has(part.trim()), `the beta corner rule re-exempts a capsule: ${part.trim()}`).toBe(false)
      }
    }
  })

  it('keeps the floating panels and their material on the same corner geometry', () => {
    // The material declares the property, so search the shaped rules: its
    // declarations live in `03-shell-sidebar.css` while the shape override sits
    // with the other corner policy in `12-squircle-corners.css`.
    const material = shaped.find(
      ({ selector }) => selector.includes('.sidebar-surface::before') && selector.includes('.workspace-panel-surface::before'),
    )
    expect(material, 'the floating-panel material rule is missing').toBeDefined()
    // The material is an inset layer, so the blanket rule cannot reach it; the
    // shape has to be handed down or the frame and its own fill disagree.
    expect(material!.body).toContain('corner-shape: var(--corner-shape)')
    // An inset `round` clip draws arcs only, so it would cut this layer to a
    // round corner and leave an unpainted sliver inside the frame's
    // superellipse. `border-radius` clips the fill and the blur on its own.
    expect(material!.body).not.toContain('clip-path')
  })

  it('keeps the floating-panel material on the same corner geometry as the frame', () => {
    // The panel material is an inset ::before (so the element is not a backdrop
    // root for the popovers it opens); like the floating panels it cannot be
    // reached by the blanket rule, so the shape has to be handed down or the
    // glass and the frame's radius would draw different corners. The composer
    // card is an opaque surface now (DSH) and needs no layer of its own.
    const glass = shaped.find(({ selector }) => selector.includes('.sidebar-surface::before'))
    expect(glass, 'the floating-panel material rule is missing').toBeDefined()
    expect(glass!.body).toContain('corner-shape: var(--corner-shape)')
  })

  it('keeps corner-shape in the places that may declare it', () => {
    // Anything else setting the property would be a shadow policy: it would
    // silently win or lose by specificity rather than by the rules above.
    const selectors = shaped.map(({ selector }) => selector)
    expect(selectors).toContain('*')
    // The one inset material layer: the floating panels
    // (.sidebar-surface::before and .workspace-panel-surface::before share one rule).
    expect(selectors.filter((selector) => selector.includes('::before'))).toHaveLength(1)
    expect(selectors.filter((selector) => selector.startsWith('.active-run-indicator'))).toHaveLength(1)
    // The one place outside `12-squircle-corners.css`: beta's window layout rounds the
    // chat column's junction corner against the sidebar (`border-top-left-radius: 12px`
    // in `14-window-layout.css`) and declares `round` there. That is a real pixel
    // decision, not a duplicate of the blanket rule — measured in a maximized window,
    // the 12px corner renders 671 bytes of PNG as shipped against 609 as
    // `superellipse(1.5)` — so it stays, and the cost of staying is being listed here:
    // exactly one window-layout rule may declare the property, and its selector has to
    // say which layout it belongs to.
    const beta = selectors.filter((selector) => selector.includes("data-window-layout='beta'"))
    expect(beta).toEqual(["html[data-window-layout='beta'] :is(.core-workspace, .settings-workspace-body)"])
    expect(selectors).toHaveLength(4)
  })
})
