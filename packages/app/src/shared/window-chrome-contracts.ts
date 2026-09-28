// Main owns native window state; preload projects these facts into CSS attributes.
export const WINDOW_CHROME_QUERY_CHANNEL = 'littlesheep:window-chrome-query'
export const WINDOW_CHROME_CHANNEL = 'littlesheep:window-chrome'

export interface WindowChromeState {
  layout: 'beta' | 'chali'
  backdrop: 'acrylic' | 'vibrancy' | 'solid'
}

export function isWindowChromeState(value: unknown): value is WindowChromeState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<WindowChromeState>
  return (state.layout === 'beta' || state.layout === 'chali')
    && (state.backdrop === 'acrylic' || state.backdrop === 'vibrancy' || state.backdrop === 'solid')
}

/**
 * ───────────────────────────────────────────────────────────────────────────
 * The window-chrome hit contract
 * ───────────────────────────────────────────────────────────────────────────
 *
 * This module is the one declaration of it: which bands of the window's top edge
 * must be draggable, which controls must be clickable, and the geometry that ties
 * them — the top-bar row, the controls' island, and the hit-region hole that has
 * to equal it. The stylesheet, the main-process shell and both gates read these
 * numbers; none of them re-declares them.
 *
 * THE RULE (measured on a real window, 2026-09-28)
 *
 * The renderer publishes its `-webkit-app-region` boxes to the OS as the window's
 * draggable region, and Windows answers its own `WM_NCHITTEST` from that region:
 * `HTCAPTION` (2) inside it — the press becomes a caption interaction and the page
 * never sees it — and `HTCLIENT` (1) outside it. DOM hit testing
 * (`elementFromPoint`) and CDP input both sit *below* that filter, which is how
 * three pinned controls came to be reported as reachable while a real mouse press
 * on every one of them did nothing.
 *
 * That region is accumulated in **DOM pre-order** and ignores `z-index`
 * completely, and a `no-drag` box only subtracts rectangles contributed **before**
 * it. `.app-nav-controls` is `.window-shell`'s first child, so its own `no-drag` is
 * spent before `.window-titlebar` (row 1 of column 3), `.window-drag-band` (row 1
 * of column 1) and the settings surface's band have contributed anything, and those
 * boxes then fill the island straight back in. Measured: `HTCAPTION` at the centre
 * of all three controls in the expanded, collapsed and mid-resize states alike.
 *
 * The island is therefore carved by a generated `::after` box on `.window-shell`.
 * A generated box is the **last** thing in its originating element's pre-order
 * subtree, so it is subtracted after every band above it — the top bar, the panel
 * band, and the settings band that `.overlays` renders later still — and
 * `pointer-events: none` keeps the hole itself out of DOM hit testing (with `auto`
 * the hole becomes the element under the pointer and takes the very clicks it
 * carves out). The hole must not be moved earlier in the tree: any band that
 * contributes its rectangle after the hole survives it.
 *
 * `pointer-events` on a *band* is not a fix for an unclickable control: the region
 * is computed from `-webkit-app-region` alone, so it carves nothing, and it costs
 * the band its pointer bridge — the second half of its drag behaviour.
 *
 * The hole is exactly the controls' island: a hole larger than the controls turns
 * part of the drag strip into dead space, and a smaller one leaves part of a
 * control unclickable. Both are asserted against the live window in
 * `scripts/verify-window-layout.mjs`; the stylesheet is bound to these numbers by
 * `scripts/lib/window-chrome-contract.mjs`.
 */

export type WindowChromeLayout = WindowChromeState['layout']

/** A band of the window's top edge the OS must resolve as caption (`HTCAPTION`). */
export interface WindowChromeDragBand {
  id: 'titlebar' | 'sidebar-band'
  /** Class name of the element that carries `-webkit-app-region: drag`. */
  selector: '.window-titlebar' | '.window-drag-band'
  /** Layout states in which the band paints a box on the top-bar row. */
  layouts: readonly WindowChromeLayout[]
}

/**
 * `chali` splits the top edge between the two bands: the sidebar column owns the
 * window's top-left corner, so the top bar only starts at the sidebar's right
 * edge and the transparent band covers the column the bar does not. `beta` spans
 * the bar over every column and the band paints nothing.
 */
export const WINDOW_CHROME_DRAG_BANDS: readonly WindowChromeDragBand[] = [
  { id: 'titlebar', selector: '.window-titlebar', layouts: ['chali', 'beta'] },
  { id: 'sidebar-band', selector: '.window-drag-band', layouts: ['chali'] },
]

/** A control whose centre a real mouse press must reach the page through. */
export interface WindowChromeControl {
  id: 'sidebar-toggle' | 'nav-back' | 'nav-forward'
  /** Resolved against the island below; the centre of this box is probed natively. */
  selector: string
}

/**
 * Rendered together in one shell-level fixed layer (`.app-nav-controls`) by
 * `renderer/sidebar/global-titlebar.tsx`. They are pinned to the window's own
 * top-left corner rather than laid out in the top bar, so the sidebar toggle
 * stays where it was in every sidebar state.
 */
export const WINDOW_CHROME_CONTROLS: readonly WindowChromeControl[] = [
  { id: 'sidebar-toggle', selector: '.app-nav-controls .sidebar-toggle-btn' },
  { id: 'nav-back', selector: '.app-nav-controls .app-nav-btn.nav-back' },
  { id: 'nav-forward', selector: '.app-nav-controls .app-nav-btn.nav-forward' },
]

/** The layer the controls are rendered in; its box is the island the hole carves. */
export const WINDOW_CHROME_ISLAND_SELECTOR = '.app-nav-controls'
/** The box each control itself occupies inside the island. */
export const WINDOW_CHROME_CONTROL_BOX_SELECTOR = '.app-nav-controls > .sidebar-toggle-btn, .app-nav-controls > .app-nav-btn'
/** The generated box that subtracts the island from every drag band. */
export const WINDOW_CHROME_HOLE_SELECTOR = '.window-shell::after'

export interface WindowChromeGeometry {
  /** The top-bar row. Also the native caption-button row (`DESKTOP_TITLEBAR_HEIGHT`). */
  topBarHeight: number
  /** One pinned control's box; the hole's height is the same number. */
  controlWidth: number
  controlHeight: number
  /** Space between two adjacent pinned controls. */
  controlGap: number
  /** Inline inset of the island — the top bar's own content inset. */
  inlineInset: number
}

export const WINDOW_CHROME_GEOMETRY: WindowChromeGeometry = {
  topBarHeight: 32,
  controlWidth: 24,
  controlHeight: 24,
  controlGap: 4,
  inlineInset: 8,
}

/**
 * One deliberate, bounded exception to "the whole top edge drags": the sidebar's
 * resize seam straddles the grid boundary, is `no-drag` and predates the pinned
 * controls, so a few pixels of the top edge resize the sidebar instead of moving
 * the window. Declared here so the native top-edge scan can allow it by width
 * rather than tolerating whatever it finds.
 */
export const WINDOW_CHROME_RESIZE_SEAM: { selector: '.sidebar-resizer'; width: number; layouts: readonly WindowChromeLayout[] } = {
  selector: '.sidebar-resizer',
  width: 8,
  layouts: ['chali'],
}

/**
 * The other part of the top edge this contract does not own: the native caption
 * buttons Windows paints over the top bar's right end (`setTitleBarOverlay`), and
 * the strip the bar reserves for them with its own right padding. Measured on
 * 2026-09-28: the pixels of that strip answer `HTCLOSE` (20), `HTMAXBUTTON` (9) and
 * `HTMINBUTTON` (8) — never `HTCLIENT` — because they are the OS's buttons, not
 * page content and not a drag surface. The scan allows the declared reservation
 * rather than whatever the OS reports, so a bar that stopped reserving the space
 * (its content sliding under the buttons) fails instead of passing.
 */
export const WINDOW_CHROME_CAPTION_STRIP: { selector: '.window-titlebar'; inset: number } = {
  selector: '.window-titlebar',
  inset: 150,
}

export interface WindowChromeBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The controls' island in CSS pixels: what the hole must equal, and what every
 * native probe is derived from. Centres the control box in the top-bar row and
 * places it at the bar's own inline inset, so the pinned position is the position
 * the controls already have whenever the bar starts at x = 0.
 */
export function windowChromeControlsBox(geometry: WindowChromeGeometry = WINDOW_CHROME_GEOMETRY): WindowChromeBox {
  const count = WINDOW_CHROME_CONTROLS.length
  return {
    left: geometry.inlineInset,
    top: (geometry.topBarHeight - geometry.controlHeight) / 2,
    width: (count * geometry.controlWidth) + ((count - 1) * geometry.controlGap),
    height: geometry.controlHeight,
  }
}

/**
 * Main's own top-bar row (`DESKTOP_TITLEBAR_HEIGHT`, the startup page's titlebar
 * and the Beta caption-button overlay) has to be this contract's row: the native
 * captions are painted over the same 32px the renderer lays out. Main cannot see
 * the stylesheet, so the comparison is stated here, once, and both callers use it
 * — `installDesktopWindowChrome` at window creation and the gates after it.
 */
export function windowChromeNativeTitlebarMismatch(nativeTitlebarHeight: number): string | null {
  if (nativeTitlebarHeight === WINDOW_CHROME_GEOMETRY.topBarHeight) return null
  return `native titlebar row is ${nativeTitlebarHeight}px but the window-chrome contract declares a ${WINDOW_CHROME_GEOMETRY.topBarHeight}px top bar`
}

/**
 * The custom properties the renderer stylesheet must use for this contract. The
 * offsets the controls and the hole share are derived **in CSS** from these two,
 * so the hole cannot sit anywhere but under the controls; the box size cannot be
 * derived in CSS without re-declaring the controls' own literals, so it is bound
 * by the gate instead (`scripts/lib/window-chrome-contract.mjs`).
 */
export const WINDOW_CHROME_STYLE_VARIABLES: { topBarHeight: string; controlsTop: string; controlsInset: string } = {
  topBarHeight: '--window-titlebar-height',
  controlsTop: '--window-nav-controls-top',
  controlsInset: '--window-nav-controls-inset',
}
