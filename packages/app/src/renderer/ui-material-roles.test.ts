import { readRendererStyleSource } from './style-source-test-utils'
import { describe, expect, it } from 'vitest'

/**
 * The glass inventory (V1).
 *
 * `backdrop-filter` is the most expensive material in the renderer and the one
 * that fails silently: painted on an element that is itself inside another
 * filtered subtree, a descendant's blur samples only what its backdrop root has
 * already drawn, so the glass reads as "crisp page behind a translucent fill"
 * (see `composer/README.md` for the measured 60/255 vs 1/255 stripe step). The
 * taskbook allows glass on exactly four layers - floating panels, the composer,
 * the floating task bar and menus - so this file DERIVES the list of rules that
 * declare a blur and compares it with that inventory.
 *
 * Adding a glass surface therefore means adding its selector and its role here
 * (and to the role table in `ui/README.md`); a new blur radius fails as well,
 * because every recipe below is a decided material rather than a number a page
 * picked on its own.
 *
 * The two `none` entries are not materials: they turn the blur off for the
 * duration of a column drag, where a full-height blur would have to resample the
 * scene on every display frame.
 */

const styles = await readRendererStyleSource()

interface Rule {
  selector: string
  body: string
}

/** Every `selector { … }` pair, with comments removed first. */
function rules(source: string): Rule[] {
  const withoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .map((match) => ({ selector: (match[1] ?? '').replaceAll(/\s+/gu, ' ').trim(), body: match[2] ?? '' }))
    .filter(({ selector }) => selector.length > 0 && !selector.startsWith('@'))
}

function backdropOf(body: string): string | null {
  return /(?:^|;)\s*(?:-webkit-)?backdrop-filter:\s*([^;]+)/u.exec(body)?.[1]?.trim() ?? null
}

/** The only declarations the renderer may carry, keyed by material role. */
const MATERIAL_ROLES: Record<string, { selectors: string[]; recipes: string[] }> = {
  'composer-glass': {
    selectors: ['.composer'],
    recipes: ['blur(20px) saturate(135%)'],
  },
  // Floating panels: the sidebar card and the workspace panel.
  'panel-glass': {
    selectors: ['.sidebar-surface::before, .workspace-panel-surface::before'],
    recipes: ['blur(20px) saturate(145%)'],
  },
  // The floating surfaces that hover above the transcript and the composer: the
  // task pill and its panel, the sidebar menu and the two menu families. The
  // conversation's own floaters (the way back to the newest message, the turn
  // directory) moved onto the opaque card + elevation recipe with the rest of the
  // conversation area, so they are not glass any more.
  'float-glass': {
    selectors: [
      '.running-pill',
      // The reach-latest droplet floats over the transcript like the rest of the
      // floating controls, so it takes the same glass instead of an opaque chip.
      '.chat-jump-button',
      '.settings-select-menu',
      '.running-pill-panel',
      '.sidebar-menu-panel',
      '.split-button-menu',
      '.workspace-add-panel',
      '.add-menu-panel, .model-picker-panel, .runtime-menu-shell .runtime-picker-panel, .runtime-menu-shell .runtime-submenu',
      // The transient confirmation that clears itself: it floats over whatever page
      // raised it, so it takes the same menu glass as the other floaters.
      '.transient-toast',
      '.conversation-resources-panel',
    ],
    recipes: ['blur(18px) saturate(135%)'],
  },
  // The workspace tab plate inside the panel: a 26px chip that has to stay
  // legible over the chat column, so it carries a lighter blur of its own. The chip
  // that reopens a collapsed workspace is that same tab-row plate.
  'tab-glass': {
    selectors: ['.workspace-active-item', '.workspace-panel-reopen-icon'],
    recipes: ['blur(12px) saturate(135%)'],
  },
  // Scrims dim the page behind a modal surface. They are not a material: no
  // content sits on them, so they keep their own small blur and their own fill.
  // The settings canvas normally disables its page overlay, but a real
  // DangerConfirmDialog remains a modal scrim and restores that same recipe.
  scrim: {
    selectors: [
      '.overlay',
      '.project-creator-scrim',
      '.settings-workspace .overlay.danger-confirm-overlay',
    ],
    recipes: ['blur(8px)', 'blur(5px)'],
  },
}

/**
 * Rules that remove the blur again. Neither is a material:
 * - a live column drag cannot afford a full-height blur resampling the scene on
 *   every display frame;
 * - the settings surface renders its own transparent overlay (it is a page, not a
 *   modal), so no scrim dims or blurs the canvas behind it.
 */
const BLUR_OVERRIDES = [
  "html[data-window-layout='beta'] .sidebar-surface::before",
  '.workspace-panel-surface::before',
  'body.is-resizing-column .window-shell.workspace-panel-drag-live .workspace-panel-surface::before, body.is-resizing-column .window-shell.workspace-panel-drag-live .workspace-active-item',
  '.settings-workspace .overlay',
  '.approval-presence .approval-inline, .approval-presence.visible .approval-inline',
]

describe('material roles', () => {
  const glassRules = rules(styles)
    .map((rule) => ({ ...rule, backdrop: backdropOf(rule.body) }))
    .filter((rule): rule is Rule & { backdrop: string } => rule.backdrop !== null)

  it('paints glass only where the material table says it may', () => {
    const declared = new Set(Object.values(MATERIAL_ROLES).flatMap((role) => role.selectors))
    const actual = glassRules
      .filter((rule) => rule.backdrop !== 'none')
      .map((rule) => rule.selector)
    expect([...actual].sort()).toEqual([...declared].sort())
  })

  it('uses one decided recipe per material role instead of per-page blur radii', () => {
    const allowed = new Set(Object.values(MATERIAL_ROLES).flatMap((role) => role.recipes))
    for (const rule of glassRules) {
      if (rule.backdrop === 'none') continue
      expect(allowed.has(rule.backdrop), `${rule.selector} declares ${rule.backdrop}`).toBe(true)
    }
  })

  it('turns the blur off only for a live column drag and the settings canvas overlay', () => {
    const disabled = glassRules.filter((rule) => rule.backdrop === 'none').map((rule) => rule.selector)
    expect([...disabled].sort()).toEqual([...BLUR_OVERRIDES].sort())
  })

  it('keeps the big materials on inset pseudo-elements, so their panels are not backdrop roots', () => {
    // The floating panels paint their material in an inset `::before`; the element
    // itself stays transparent. If the material moved onto the element, every popover
    // inside it would lose its own backdrop. The input is a separate floating glass
    // surface whose requested material is checked below.
    const panel = rules(styles).find((rule) => rule.selector === '.sidebar-surface')
    expect(panel, '.sidebar-surface rule is missing').toBeDefined()
    expect(panel!.body).toContain('background: transparent;')
    expect(backdropOf(panel!.body), '.sidebar-surface must not carry the blur itself').toBeNull()

    const composer = rules(styles).find((rule) => rule.selector === '.composer')
    expect(composer, '.composer rule is missing').toBeDefined()
    expect(backdropOf(composer!.body)).toBe('blur(20px) saturate(135%)')
  })

  it('gives long content a stable fill instead of glass', () => {
    // Long prose, code and dense settings content sit on a solid canvas: the
    // transcript scroller, the settings page surface and the code toolbar never
    // blur, and the settings page keeps the workspace code fill as its canvas.
    const settingsCanvas = rules(styles).find((rule) => rule.selector === '.settings-page-transition')
    expect(settingsCanvas, 'the settings page surface rule is missing').toBeDefined()
    expect(settingsCanvas!.body).toContain('background: var(--workspace-code-surface);')
    expect(backdropOf(settingsCanvas!.body)).toBeNull()

    const toolbar = rules(styles).find((rule) => rule.selector === '.code-toolbar')
    expect(toolbar, 'the code toolbar rule is missing').toBeDefined()
    expect(toolbar!.body).toContain('background: var(--surface-2);')
    expect(backdropOf(toolbar!.body)).toBeNull()

    for (const rule of rules(styles)) {
      if (!/^\.message\b/u.test(rule.selector)) continue
      expect(backdropOf(rule.body), `${rule.selector} must not blur long content`).toBeNull()
    }
  })
})

describe('shadow roles', () => {
  it('keeps one token per elevation instead of repeating the menu shadow literal', () => {
    expect(styles).toContain('--shadow: 0 18px 46px rgba(0, 0, 0, 0.38);')
    expect(styles).toContain('--shadow-menu: 0 22px 54px rgba(0, 0, 0, 0.44);')
    expect(styles).toContain('--floating-panel-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);')
    // The menu/picker layer used to repeat this literal seven times.
    expect(styles).not.toContain('box-shadow: 0 22px 54px rgba(0, 0, 0, 0.44);')
    // The conversation's own popovers moved to the panel-elevation token, so the
    // menu-shadow family is smaller than it was; the role still has to be shared.
    const menuShadowUsers = rules(styles).filter((rule) => rule.body.includes('box-shadow: var(--shadow-menu);'))
    expect(menuShadowUsers.length).toBeGreaterThanOrEqual(5)
    const panelElevationUsers = rules(styles).filter((rule) => rule.body.includes('box-shadow: var(--chat-panel-elevation);'))
    expect(panelElevationUsers.length).toBeGreaterThanOrEqual(5)
  })

  it('keeps the two floating glass panels the user reads shadowless', () => {
    // Asked for 2026-10-15: the wide dark drop shadow of the resources popover and
    // of the task pill's panel read as a halo around them against the dark
    // transcript, so their translucent fill alone marks the float. The same rule is
    // measured in real Electron by `scripts/verify-conversation-resources-motion.mjs`
    // and `scripts/verify-chat-navigation.mjs`.
    for (const cls of ['.conversation-resources-panel', '.running-pill-panel']) {
      const token = new RegExp(`${cls.replace('.', '\\.')}(?![\\w-])`, 'u')
      const offenders = rules(styles)
        .filter((rule) => rule.selector.split(',').some((part) => token.test(part.trim())))
        .filter((rule) => rule.body.includes('box-shadow:'))
      expect(offenders.map((rule) => rule.selector), `${cls} must not paint a box shadow`).toEqual([])
      expect(rules(styles).some((rule) => rule.selector === cls), `${cls} rule is missing`).toBe(true)
    }
  })
})
