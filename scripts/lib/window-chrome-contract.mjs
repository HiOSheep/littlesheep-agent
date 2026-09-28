// The declared window-chrome contract, checked against the stylesheet that has to
// implement it and the renderer DOM that has to render it.
//
// This module is the gate's single implementation: the renderer suite
// (`chat-layout-stability.test.ts`) and the native window gate
// (`verify-window-layout.mjs`) both call it, so the source-level half of the
// contract cannot be enforced in one place and forgotten in the other.
//
// The numbers live in `packages/app/src/shared/window-chrome-contracts.ts`, and
// this module reads them from that TypeScript source directly (Node's type
// stripping; the app package publishes no `dist` the gate could import instead).
// Nothing here re-declares a length: every expected value is derived from the
// contract, and every CSS length is evaluated from the stylesheet's own tokens and
// calc() expressions, so a change on either side reads as a disagreement rather
// than as two constants that happen to match.
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WINDOW_CHROME_CAPTION_STRIP,
  WINDOW_CHROME_CONTROLS,
  WINDOW_CHROME_CONTROL_BOX_SELECTOR,
  WINDOW_CHROME_DRAG_BANDS,
  WINDOW_CHROME_GEOMETRY,
  WINDOW_CHROME_HOLE_SELECTOR,
  WINDOW_CHROME_ISLAND_SELECTOR,
  WINDOW_CHROME_RESIZE_SEAM,
  WINDOW_CHROME_STYLE_VARIABLES,
  windowChromeControlsBox,
  windowChromeNativeTitlebarMismatch,
} from '../../packages/app/src/shared/window-chrome-contracts.ts'

export const WINDOW_CHROME_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Every source the source-level half of the contract is read from. */
export const WINDOW_CHROME_CONTRACT_SOURCES = {
  stylesManifest: 'packages/app/src/renderer/styles.css',
  rendererRoot: 'packages/app/src/renderer',
  windowLayout: 'packages/app/src/renderer/styles/14-window-layout.css',
  globalTitlebar: 'packages/app/src/renderer/sidebar/global-titlebar.tsx',
  appView: 'packages/app/src/renderer/app-shell/app-view.tsx',
  nativeTitlebar: 'packages/app/src/main/desktop-startup-page.ts',
  desktopWindowChrome: 'packages/app/src/main/desktop-window-chrome.ts',
}

/**
 * Read the gate's inputs. The stylesheet is assembled from the renderer's own
 * ordered `@import` manifest rather than from a second list here: a file the app
 * imports but the gate skipped would be a hole in the gate.
 */
export async function loadWindowChromeContractSources(repoRoot = WINDOW_CHROME_REPO_ROOT) {
  const read = (path) => readFile(resolve(repoRoot, path), 'utf8')
  const manifest = await read(WINDOW_CHROME_CONTRACT_SOURCES.stylesManifest)
  const imports = [...manifest.matchAll(/@import '([^']+)';/gu)].map((match) => match[1])
  if (imports.length === 0) throw new Error('the renderer stylesheet has no @import manifest to assemble')
  const parts = await Promise.all(imports.map((path) => read(join(WINDOW_CHROME_CONTRACT_SOURCES.rendererRoot, path))))
  const [windowLayout, globalTitlebar, appView, nativeTitlebar, desktopWindowChrome] = await Promise.all([
    read(WINDOW_CHROME_CONTRACT_SOURCES.windowLayout),
    read(WINDOW_CHROME_CONTRACT_SOURCES.globalTitlebar),
    read(WINDOW_CHROME_CONTRACT_SOURCES.appView),
    read(WINDOW_CHROME_CONTRACT_SOURCES.nativeTitlebar),
    read(WINDOW_CHROME_CONTRACT_SOURCES.desktopWindowChrome),
  ])
  return { styles: parts.join(''), windowLayout, globalTitlebar, appView, nativeTitlebar, desktopWindowChrome }
}

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//gu, '')

/**
 * Every rule in `source`, with its selector whitespace normalized so a multi-line
 * selector list matches the one-line form the contract declares. `nested` marks a
 * rule inside an at-rule (the renderer's layout media queries), which is a different
 * fact from a rule that exists in every layout.
 */
export function ruleScopes(source) {
  const text = stripComments(source)
  const scopes = []
  for (let open = text.indexOf('{'); open >= 0; open = text.indexOf('{', open + 1)) {
    const close = text.indexOf('}', open)
    if (close < 0) break
    let start = open - 1
    while (start >= 0 && text[start] !== '}' && text[start] !== '{' && text[start] !== ';') start -= 1
    const before = text.slice(0, open)
    const nested = (before.match(/\{/gu)?.length ?? 0) > (before.match(/\}/gu)?.length ?? 0)
    scopes.push({
      selector: text.slice(start + 1, open).replace(/\s+/gu, ' ').trim(),
      body: text.slice(open + 1, close),
      nested,
    })
  }
  return scopes
}

/** The body of the one *unscoped* rule for `selector`: the whole selector has to match. */
export function ruleBody(source, selector) {
  return ruleScopes(source).find((scope) => scope.selector === selector && !scope.nested)?.body ?? null
}

export function ruleDeclarations(body) {
  const declarations = new Map()
  for (const chunk of body.split(';')) {
    const separator = chunk.indexOf(':')
    if (separator < 0) continue
    const property = chunk.slice(0, separator).trim()
    if (property) declarations.set(property, chunk.slice(separator + 1).trim())
  }
  return declarations
}

function customProperties(styles) {
  const properties = new Map()
  for (const [property, value] of ruleDeclarations(ruleBody(styles, ':root') ?? '')) {
    if (property.startsWith('--')) properties.set(property, value)
  }
  return properties
}

/**
 * A declaration flattened into arithmetic over pixels: every `var()` is replaced by
 * its own expression, and a wrapping `calc()` is unwrapped.
 */
function flattenLength(value, properties, depth = 0) {
  if (depth > 8) throw new Error(`custom property cycle at ${value}`)
  const text = String(value).trim()
  const reference = /^var\((--[a-z0-9-]+)\)$/iu.exec(text)
  if (reference) {
    const referenced = properties.get(reference[1])
    if (referenced === undefined) throw new Error(`undeclared custom property ${reference[1]}`)
    return flattenLength(referenced, properties, depth + 1)
  }
  return text.replace(/var\((--[a-z0-9-]+)\)/giu, (_, name) => {
    const referenced = properties.get(name)
    if (referenced === undefined) throw new Error(`undeclared custom property ${name}`)
    const resolved = flattenLength(referenced, properties, depth + 1)
    const calc = /^calc\(([\s\S]*)\)$/iu.exec(resolved)
    return `(${calc ? calc[1] : resolved})`
  })
}

/**
 * Arithmetic over pixel lengths, strict on purpose: anything the tokenizer cannot
 * consume (a percentage, a font-relative unit, a stray word) is an error rather
 * than a silently ignored term, because the gate compares two sides of an equation
 * and a term it cannot read would make that comparison meaningless.
 */
function evaluateArithmetic(expression) {
  const tokens = expression.match(/\d+(?:\.\d+)?(?:px)?|[-+*/()]/gu) ?? []
  if (tokens.length === 0 || tokens.join('') !== expression.replace(/\s+/gu, '')) {
    throw new Error(`not a pixel expression: ${expression.trim()}`)
  }
  let position = 0
  const parseExpression = () => {
    let value = parseTerm()
    for (;;) {
      const operator = tokens[position]
      if (operator !== '+' && operator !== '-') return value
      position += 1
      const right = parseTerm()
      value = operator === '+' ? value + right : value - right
    }
  }
  const parseTerm = () => {
    let value = parseFactor()
    for (;;) {
      const operator = tokens[position]
      if (operator !== '*' && operator !== '/') return value
      position += 1
      const right = parseFactor()
      value = operator === '*' ? value * right : value / right
    }
  }
  const parseFactor = () => {
    const token = tokens[position]
    if (token === '-') { position += 1; return -parseFactor() }
    if (token === '+') { position += 1; return parseFactor() }
    if (token === '(') {
      position += 1
      const value = parseExpression()
      if (tokens[position] !== ')') throw new Error(`unbalanced parentheses in ${expression.trim()}`)
      position += 1
      return value
    }
    if (token === undefined || !/\d/u.test(token)) throw new Error(`not a pixel length in ${expression.trim()}`)
    position += 1
    return Number.parseFloat(token)
  }
  const value = parseExpression()
  if (position !== tokens.length) throw new Error(`trailing input in ${expression.trim()}`)
  return value
}

/** A CSS length in CSS pixels, resolved through the stylesheet's custom properties. */
export function evaluateLength(value, properties) {
  const text = flattenLength(value, properties)
  const calc = /^calc\(([\s\S]*)\)$/iu.exec(text)
  return evaluateArithmetic(calc ? calc[1] : text)
}

function countOccurrences(haystack, needle) {
  let count = 0
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) count += 1
  return count
}

const controlClassTokens = (selector) => selector
  .slice(WINDOW_CHROME_ISLAND_SELECTOR.length)
  .split('.')
  .map((token) => token.trim())
  .filter(Boolean)

/**
 * Every way the stylesheet, the DOM or the main process can disagree with the
 * declared window-chrome contract. An empty array is a pass; each entry names the
 * fact that is wrong rather than the two numbers that differ, because the point of
 * the gate is to say which side has to move.
 */
export function windowChromeContractViolations(sources) {
  const violations = []
  const fail = (message) => violations.push(message)
  const properties = customProperties(sources.styles)
  const box = windowChromeControlsBox()
  const count = WINDOW_CHROME_CONTROLS.length

  for (const [name, length] of Object.entries(box)) {
    if (!Number.isInteger(length)) fail(`the contract's island is not on whole pixels: ${name} = ${length}`)
  }

  const length = (value, what) => {
    if (value === undefined) { fail(`${what} is not declared`); return undefined }
    try {
      return evaluateLength(value, properties)
    } catch (error) {
      fail(`${what} (${value}) is not a resolvable pixel length: ${error.message}`)
      return undefined
    }
  }

  // 1. The top-bar row. The stylesheet owns the token; the contract owns the number.
  const topBarHeight = length(properties.get(WINDOW_CHROME_STYLE_VARIABLES.topBarHeight), `${WINDOW_CHROME_STYLE_VARIABLES.topBarHeight}`)
  if (topBarHeight !== undefined && topBarHeight !== WINDOW_CHROME_GEOMETRY.topBarHeight) {
    fail(`${WINDOW_CHROME_STYLE_VARIABLES.topBarHeight} is ${topBarHeight}px but the contract declares a ${WINDOW_CHROME_GEOMETRY.topBarHeight}px top bar`)
  }

  // 2. The controls' island: pinned to the window, and the offsets it and the hole share.
  const islandBody = ruleBody(sources.styles, WINDOW_CHROME_ISLAND_SELECTOR)
  if (islandBody === null) fail(`${WINDOW_CHROME_ISLAND_SELECTOR} has no unscoped rule`)
  const island = ruleDeclarations(islandBody ?? '')
  const reference = (name) => `var(${name})`
  if (island.get('position') !== 'fixed') fail(`${WINDOW_CHROME_ISLAND_SELECTOR} is not pinned to the window (position: ${island.get('position')})`)
  if (island.get('top') !== reference(WINDOW_CHROME_STYLE_VARIABLES.controlsTop)) fail(`${WINDOW_CHROME_ISLAND_SELECTOR} does not take its top offset from ${WINDOW_CHROME_STYLE_VARIABLES.controlsTop}`)
  if (island.get('left') !== reference(WINDOW_CHROME_STYLE_VARIABLES.controlsInset)) fail(`${WINDOW_CHROME_ISLAND_SELECTOR} does not take its inline inset from ${WINDOW_CHROME_STYLE_VARIABLES.controlsInset}`)
  if (island.get('-webkit-app-region') !== 'no-drag') fail(`${WINDOW_CHROME_ISLAND_SELECTOR} does not declare -webkit-app-region: no-drag`)

  const declaredTop = length(properties.get(WINDOW_CHROME_STYLE_VARIABLES.controlsTop), WINDOW_CHROME_STYLE_VARIABLES.controlsTop)
  if (declaredTop !== undefined && declaredTop !== box.top) fail(`${WINDOW_CHROME_STYLE_VARIABLES.controlsTop} resolves to ${declaredTop}px, but the contract centers the ${WINDOW_CHROME_GEOMETRY.controlHeight}px control box at ${box.top}px`)
  const declaredInset = length(properties.get(WINDOW_CHROME_STYLE_VARIABLES.controlsInset), WINDOW_CHROME_STYLE_VARIABLES.controlsInset)
  if (declaredInset !== undefined && declaredInset !== box.left) fail(`${WINDOW_CHROME_STYLE_VARIABLES.controlsInset} is ${declaredInset}px but the contract insets the island by ${box.left}px`)

  // 3. The box each control occupies, and the gap between them. These are the numbers
  //    the island's laid-out width is derived from, so a wider button or a larger gap
  //    cannot leave the hole behind.
  const buttonBody = ruleBody(sources.styles, WINDOW_CHROME_CONTROL_BOX_SELECTOR)
  if (buttonBody === null) fail(`${WINDOW_CHROME_CONTROL_BOX_SELECTOR} has no unscoped rule`)
  const button = ruleDeclarations(buttonBody ?? '')
  const controlWidth = length(button.get('width'), `${WINDOW_CHROME_CONTROL_BOX_SELECTOR} width`)
  const controlHeight = length(button.get('height'), `${WINDOW_CHROME_CONTROL_BOX_SELECTOR} height`)
  const controlGap = length(island.get('gap'), `${WINDOW_CHROME_ISLAND_SELECTOR} gap`)
  if (controlWidth !== undefined && controlWidth !== WINDOW_CHROME_GEOMETRY.controlWidth) fail(`each control is ${controlWidth}px wide but the contract declares ${WINDOW_CHROME_GEOMETRY.controlWidth}px`)
  if (controlHeight !== undefined && controlHeight !== WINDOW_CHROME_GEOMETRY.controlHeight) fail(`each control is ${controlHeight}px tall but the contract declares ${WINDOW_CHROME_GEOMETRY.controlHeight}px`)
  if (controlGap !== undefined && controlGap !== WINDOW_CHROME_GEOMETRY.controlGap) fail(`the controls are ${controlGap}px apart but the contract declares a ${WINDOW_CHROME_GEOMETRY.controlGap}px gap`)
  if (!/flex/u.test(island.get('display') ?? '')) fail(`${WINDOW_CHROME_ISLAND_SELECTOR} does not lay its controls out in a row (display: ${island.get('display')})`)

  // 4. The hole. Exactly one unscoped rule, carrying no paint, sharing both offsets
  //    with the island and equal to the island's own box — no larger (that would put
  //    dead space in the drag strip) and no smaller (that would leave part of a
  //    control unclickable).
  const holeScopes = ruleScopes(sources.styles).filter((scope) => scope.selector === WINDOW_CHROME_HOLE_SELECTOR)
  if (holeScopes.length !== 1) fail(`${WINDOW_CHROME_HOLE_SELECTOR} appears in ${holeScopes.length} rules; the no-drag hole must be exactly one box`)
  if (holeScopes[0]?.nested) fail(`${WINDOW_CHROME_HOLE_SELECTOR} only exists inside an at-rule; the island would stay draggable wherever that condition does not hold`)
  if (sources.windowLayout.includes(WINDOW_CHROME_HOLE_SELECTOR)) fail(`the layout layer scopes ${WINDOW_CHROME_HOLE_SELECTOR}; that would leave the island draggable in one of the two layouts`)
  const hole = ruleDeclarations(holeScopes[0]?.body ?? '')
  if (hole.get('content') !== "''") fail(`${WINDOW_CHROME_HOLE_SELECTOR} is not a generated box (content: ${hole.get('content')})`)
  if (hole.get('position') !== 'fixed') fail(`${WINDOW_CHROME_HOLE_SELECTOR} is not positioned against the window (position: ${hole.get('position')})`)
  if (hole.get('-webkit-app-region') !== 'no-drag') fail(`${WINDOW_CHROME_HOLE_SELECTOR} does not subtract anything from the draggable region`)
  if (hole.get('pointer-events') !== 'none') fail(`${WINDOW_CHROME_HOLE_SELECTOR} is not click-through; a hole that can be clicked takes the clicks it carves out`)
  if (hole.get('top') !== island.get('top')) fail(`${WINDOW_CHROME_HOLE_SELECTOR} and ${WINDOW_CHROME_ISLAND_SELECTOR} must share one top offset, not two copies of it`)
  if (hole.get('left') !== island.get('left')) fail(`${WINDOW_CHROME_HOLE_SELECTOR} and ${WINDOW_CHROME_ISLAND_SELECTOR} must share one inline inset, not two copies of it`)
  const holeWidth = length(hole.get('width'), `${WINDOW_CHROME_HOLE_SELECTOR} width`)
  const holeHeight = length(hole.get('height'), `${WINDOW_CHROME_HOLE_SELECTOR} height`)
  if (holeWidth !== undefined && holeWidth !== box.width) fail(`the hole is ${holeWidth}px wide but the contract's three controls and two gaps add up to ${box.width}px`)
  if (holeHeight !== undefined && holeHeight !== box.height) fail(`the hole is ${holeHeight}px tall but the contract's control box is ${box.height}px`)
  if (controlWidth !== undefined && controlGap !== undefined) {
    const laidOut = (controlWidth * count) + (controlGap * (count - 1))
    if (laidOut !== box.width) fail(`the stylesheet's own controls add up to ${laidOut}px but the contract declares a ${box.width}px island`)
  }
  for (const property of ['background', 'background-color', 'border', 'box-shadow', 'backdrop-filter', 'filter']) {
    if (hole.has(property)) fail(`${WINDOW_CHROME_HOLE_SELECTOR} paints (${property}); the hole is a hit region, not a layer`)
  }

  // 5. The draggable bands, and the pointer bridge that `pointer-events: none` would cost.
  for (const band of WINDOW_CHROME_DRAG_BANDS) {
    const body = ruleBody(sources.styles, band.selector)
    if (body === null) { fail(`${band.selector} has no unscoped rule`); continue }
    const declarations = ruleDeclarations(body)
    if (declarations.get('-webkit-app-region') !== 'drag') fail(`${band.id}: ${band.selector} is not a drag surface`)
    if (declarations.get('pointer-events') === 'none') fail(`${band.id}: pointer-events: none does not carve the draggable region and costs the band its pointer bridge`)
  }
  if (!sources.globalTitlebar.includes('className="window-titlebar"')) fail('the titlebar band is not rendered by global-titlebar.tsx')
  if (!sources.appView.includes('className="window-drag-band"')) fail('the sidebar drag band is not rendered by app-view.tsx')
  if (countOccurrences(sources.globalTitlebar, 'onPointerDown={startWindowDrag}') < 2) fail('a drag band lost its pointer bridge to Main')
  if (!sources.windowLayout.includes("html[data-window-layout='beta'] .window-drag-band")) fail(`the layout layer does not hide the sidebar band in beta, but the contract declares it chali-only`)

  // 6. The two parts of the top edge this contract does not own, both declared rather
  //    than tolerated: the resize seam and the strip the bar reserves for the native
  //    caption buttons.
  const seam = ruleDeclarations(ruleBody(sources.styles, WINDOW_CHROME_RESIZE_SEAM.selector) ?? '')
  const seamWidth = length(seam.get('width'), `${WINDOW_CHROME_RESIZE_SEAM.selector} width`)
  if (seamWidth !== undefined && seamWidth !== WINDOW_CHROME_RESIZE_SEAM.width) fail(`the resize seam is ${seamWidth}px wide but the contract bounds it at ${WINDOW_CHROME_RESIZE_SEAM.width}px of the top edge`)
  if (seam.get('-webkit-app-region') !== 'no-drag') fail(`${WINDOW_CHROME_RESIZE_SEAM.selector} is not the declared no-drag seam`)
  const barPadding = (ruleDeclarations(ruleBody(sources.styles, WINDOW_CHROME_CAPTION_STRIP.selector) ?? '').get('padding') ?? '')
    .split(/\s+/u)
    .map((value) => value.trim())
    .filter(Boolean)
  // `padding: 0 150px 0 8px` — the second value is the space held for the OS buttons.
  // A padding the gate cannot read is a failure, not a pass: the reservation is the
  // only thing keeping page content out from under the OS buttons.
  const reservedForCaptions = barPadding.length === 4 ? barPadding[1] : undefined
  if (reservedForCaptions === undefined) {
    fail(`the top bar's padding is not a readable four-value shorthand (${barPadding.join(' ') || 'none'}), so its reservation for the native caption buttons cannot be checked`)
  } else {
    const reserved = length(reservedForCaptions, 'the top bar\'s right padding')
    if (reserved !== undefined && reserved !== WINDOW_CHROME_CAPTION_STRIP.inset) {
      fail(`the top bar reserves ${reserved}px on its right but the contract declares ${WINDOW_CHROME_CAPTION_STRIP.inset}px for the native caption buttons`)
    }
  }

  // 7. The native row main paints the Beta caption buttons over.
  const nativeHeight = /export const DESKTOP_TITLEBAR_HEIGHT = (\d+)/u.exec(sources.nativeTitlebar)
  if (nativeHeight === null) fail('DESKTOP_TITLEBAR_HEIGHT is no longer declared as a literal in desktop-startup-page.ts')
  else {
    const mismatch = windowChromeNativeTitlebarMismatch(Number(nativeHeight[1]))
    if (mismatch) fail(mismatch)
  }
  if (!sources.desktopWindowChrome.includes('windowChromeNativeTitlebarMismatch')) fail('desktop-window-chrome.ts does not compare its native titlebar row with the contract')

  // 8. The controls as rendered elements, and the DOM order that makes the hole necessary:
  //    the island is the shell's first child, every other drag surface comes later.
  if (!sources.globalTitlebar.includes(`className="${WINDOW_CHROME_ISLAND_SELECTOR.slice(1)}"`)) fail(`${WINDOW_CHROME_ISLAND_SELECTOR} is not rendered by global-titlebar.tsx`)
  for (const control of WINDOW_CHROME_CONTROLS) {
    for (const token of controlClassTokens(control.selector)) {
      if (!sources.globalTitlebar.includes(token)) fail(`${control.id}: ${control.selector} has no rendered element (no ${token} in global-titlebar.tsx)`)
    }
  }
  const islandAt = sources.appView.indexOf('<WindowNavControls')
  const panelsAt = sources.appView.indexOf('<div className="primary-workspace">')
  const overlaysAt = sources.appView.indexOf('<OverlaysView')
  if (islandAt < 0 || panelsAt < 0 || overlaysAt < 0 || !(islandAt < panelsAt && islandAt < overlaysAt)) {
    fail('the controls are no longer the shell\'s first layer; the no-drag hole has to be the last box in the pre-order subtree that contains every drag band')
  }

  return violations
}
