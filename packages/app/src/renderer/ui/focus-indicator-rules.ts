// The stylesheet half of rule R3 ("a focused control must be visibly focused").
//
// `focus-ownership.ts` owns the rule; this module owns the reading of it. It
// answers three questions about the renderer's stylesheets, so the rule can be
// asserted without a browser:
//
//   1. does this rule move a control into (or out of) a focus state?
//   2. does it suppress the app-wide `:focus-visible` outline?
//   3. does it draw a visible substitute (a ring or a fill)?
//
// The failure this exists to catch is defect #19's shape: a rule turns the
// outline off for keyboard focus and puts nothing in its place, so a keyboard
// user cannot see where they are. The second failure is the permission
// picker's shape: the substitute *is* drawn, but a scrolling ancestor with
// `overflow: hidden` cuts the ring's outer edge away, so the measurement comes
// out at 0.00 coverage on the clipped sides. `focus-ownership.test.ts` asserts
// both over the real stylesheet sources.
//
// Pure text in, judgements out: no filesystem, no DOM, so the same reading can
// be used by a test and by a plain script.

export interface StyleRule {
  file: string
  selector: string
  body: string
  /** Declarations in source order, `property: value`, lowercased property. */
  declarations: Array<{ property: string; value: string }>
  /** Where the rule sits in the file, so "later wins" can be judged. */
  index: number
}

/** The focus states a control can be moved into by CSS. */
const FOCUS_STATE = /:focus(?:-visible|-within)?\b/u

/** Properties that can carry a visible focus indication. */
const INDICATOR_PROPERTIES = new Set([
  'outline',
  'outline-color',
  'outline-width',
  'outline-style',
  'box-shadow',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-color',
  'filter',
])

/** Parse `property: value` declarations out of a rule body. */
export function parseDeclarations(body: string): Array<{ property: string; value: string }> {
  const declarations: Array<{ property: string; value: string }> = []
  for (const chunk of body.split(';')) {
    const separator = chunk.indexOf(':')
    if (separator < 0) continue
    const property = chunk.slice(0, separator).trim().toLowerCase()
    const value = chunk.slice(separator + 1).trim()
    if (property.length === 0 || value.length === 0) continue
    declarations.push({ property, value })
  }
  return declarations
}

/**
 * Every rule in a stylesheet source, with comments removed and `@media` /
 * `@supports` wrappers flattened away (their inner rules are still rules, and a
 * focus ring inside a media query is still a focus ring).
 */
export function parseStyleRules(file: string, source: string): StyleRule[] {
  const withoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
  const rules: StyleRule[] = []
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    // An at-rule prelude (`@media (max-width: 760px)`) is not a selector; the
    // rules it wraps are matched on their own by the same walk.
    const selector = (match[1] ?? '').replaceAll(/\s+/gu, ' ').trim()
    const body = match[2] ?? ''
    if (selector.startsWith('@')) continue
    if (selector.length === 0) continue
    rules.push({
      file,
      selector,
      body,
      declarations: parseDeclarations(body),
      index: match.index ?? 0,
    })
  }
  return rules
}

/** True when the rule moves its subject into a focus state. */
export function isFocusRule(rule: StyleRule): boolean {
  return FOCUS_STATE.test(rule.selector)
}

function declarationFor(rule: StyleRule, property: string): string | undefined {
  let found: string | undefined
  for (const declaration of rule.declarations) {
    if (declaration.property === property) found = declaration.value
  }
  return found
}

/** True when the rule sets `outline` to a value that draws nothing. */
export function suppressesOutline(rule: StyleRule): boolean {
  const outline = declarationFor(rule, 'outline')
  if (outline !== undefined) {
    return /^(?:0|none|0px(?:\s+none)?|none\s+0(?:px)?)$/u.test(outline.replaceAll(/\s+/gu, ' ').trim().toLowerCase())
  }
  const style = declarationFor(rule, 'outline-style')
  if (style !== undefined && /^none$/u.test(style.trim().toLowerCase())) return true
  const width = declarationFor(rule, 'outline-width')
  return width !== undefined && /^0(?:px|em|rem)?$/u.test(width.trim().toLowerCase())
}

/** True when the rule itself draws something a user can see. */
export function drawsIndicator(rule: StyleRule): boolean {
  for (const declaration of rule.declarations) {
    if (!INDICATOR_PROPERTIES.has(declaration.property)) continue
    const value = declaration.value.trim().toLowerCase()
    if (value.length === 0 || value === 'none' || value === 'transparent') continue
    if (/^(?:0|0px)(?:\s|$)/u.test(value)) continue
    return true
  }
  return false
}

/**
 * The subject of one selector: the compound the rule actually styles, with its
 * own state pseudo-classes removed and its class/attribute selectors kept.
 *
 *   `.a:hover:not(:disabled)`          -> `.a`
 *   `.mode-picker-panel .model-option` -> `.model-option`
 *   `.option-picker-list`              -> `.option-picker-list`
 *
 * Class and attribute selectors stay because they are part of the control's
 * identity: `.strip.active` and `.strip` are the same control, while
 * `.strip` and `.strip-link` are not. The walk stops at the first state
 * pseudo-class, because everything after it is a state rather than part of the
 * subject.
 */
export function subjectOf(selector: string): string {
  const first = selector.split(',')[0] ?? ''
  const compound = first.trim().split(/\s+/u).at(-1) ?? ''
  let out = ''
  let index = 0
  while (index < compound.length) {
    const character = compound[index]!
    if (character === ':' || character === '[') break
    out += character
    index += 1
  }
  return out.trim()
}

/**
 * The controls a rule list targets, one subject per selector in the list.
 * Reported to a reader; see `ruleKeysOf` for the comparison key.
 */
export function subjectsOf(selector: string): string[] {
  return selector
    .split(',')
    .map((part) => subjectOf(part))
    .filter((part) => part.length > 0)
}

/**
 * The comparison key for one selector: the whole selector path with each
 * compound's *state* pseudo-classes removed, so two rules about the same control
 * in different states share a key.
 *
 *   `.settings-sidebar-search input:focus`         -> `.settings-sidebar-search input`
 *   `.settings-sidebar-search input:focus-visible` -> `.settings-sidebar-search input`
 *   `.composer textarea:focus`                     -> `.composer textarea`
 *   `.a:hover:not(:disabled)`                      -> `.a`
 *
 * The path has to be kept. Keying on the subject compound alone collapsed every
 * `input` and every `textarea` in the app onto one another, which made a rule
 * that removed one field's ring look compensated by an unrelated field's ring -
 * exactly the false pass this module exists to prevent (found by removing the
 * settings-search fix and watching the gate stay green).
 */
/**
 * The comparison keys for one selector list: the whole selector path with each
 * compound's *state* pseudo-classes removed, so two rules about the same control in
 * different states share a key.
 *
 *   `.settings-sidebar-search input:focus`         -> ['.settings-sidebar-search input']
 *   `.settings-sidebar-search input:focus-visible` -> ['.settings-sidebar-search input']
 *   `.composer textarea:focus`                     -> ['.composer textarea']
 *   `.a:hover:not(:disabled)`                      -> ['.a']
 *
 * The path has to be kept. Keying on the subject compound alone collapsed every
 * `input` and every `textarea` in the app onto one another, which made a rule
 * that removed one field's ring look compensated by an unrelated field's ring -
 * exactly the false pass this module exists to prevent (found by removing the
 * settings-search fix and watching the gate stay green).
 */
export function ruleKeysOf(selector: string): string[] {
  return selector
    .split(',')
    .map((part) => part
      .trim()
      .split(/\s+/u)
      .map((compound) => {
        let out = ''
        let index = 0
        while (index < compound.length) {
          const character = compound[index]!
          if (character === ':' || character === '[') break
          out += character
          index += 1
        }
        return out
      })
      .filter((compound) => compound.length > 0)
      .join(' '))
    .filter((part) => part.length > 0)
}

export interface FocusSuppression {
  rule: StyleRule
  /** The controls this suppression applies to, as displayed to a reader. */
  subjects: string[]
  /**
   * The comparison keys: the full selector path with state pseudo-classes
   * removed. This is what an exception list matches on, because it is the only
   * form that distinguishes the app's many `input` and `textarea` elements.
   */
  keys: string[]
  /** Focus-state rules for the same control that draw a visible substitute. */
  substitutes: StyleRule[]
}

/**
 * Every focus rule that turns the outline off, paired with the *focus-state*
 * rules that draw a substitute for the same control.
 *
 * A rule that both removes the outline and declares a visible indicator is not
 * a suppression at all: the indicator is the treatment (a fill instead of a
 * frame), which is what `drawsIndicator` decides.
 *
 * Substitutes must themselves be focus rules. A `:hover` fill does not give a
 * keyboard user anything: the caret can be inside a control the pointer is
 * nowhere near, and a rule that only fires under the pointer is exactly how a
 * control ends up with a fill for the mouse and nothing for Tab.
 */
export function findFocusSuppressions(rules: StyleRule[]): FocusSuppression[] {
  const suppressions: FocusSuppression[] = []
  for (const rule of rules) {
    if (!isFocusRule(rule) || !suppressesOutline(rule) || drawsIndicator(rule)) continue
    const subjects = subjectsOf(rule.selector)
    const keys = ruleKeysOf(rule.selector)
    const substitutes = rules.filter((candidate) => {
      if (candidate === rule) return false
      if (!isFocusRule(candidate) || suppressesOutline(candidate) || !drawsIndicator(candidate)) return false
      const candidateKeys = ruleKeysOf(candidate.selector)
      return candidateKeys.some((key) => keys.includes(key))
    })
    suppressions.push({ rule, subjects, keys, substitutes })
  }
  return suppressions
}

/**
 * Scroll containers that clip, and the focus ring that has to fit inside them.
 *
 * A container clips its descendants at its *padding* edge (the padding box),
 * while an `outline` with `outline-offset: N` is drawn N px outside the
 * control's border box. The control's border box is inset from the padding box
 * by the container's own padding, so the ring fits only when that padding is at
 * least as large as the offset. This is the permission picker's defect stated
 * as arithmetic: the list had 0 padding *in the clipping axis* while every
 * option's ring asked for 2px outside its own box, so the left and right edges
 * of the ring were cut to zero coverage.
 */
export interface ClipRisk {
  container: StyleRule
  /** `overflow-x` / `overflow-y`: the axes that clip. */
  clippedAxes: Array<'x' | 'y'>
  /** Padding available to the ring on each clipped axis. */
  clearance: { x: number; y: number }
  /** The largest `outline-offset` any descendant focus ring asks for. */
  offset: number
}

function overflowAxis(rule: StyleRule, axis: 'x' | 'y'): boolean {
  const shorthand = declarationFor(rule, 'overflow')
  const longhand = declarationFor(rule, `overflow-${axis}`)
  const value = (longhand ?? shorthand ?? '').trim().toLowerCase()
  return value === 'hidden' || value === 'clip' || value === 'auto' || value === 'scroll'
}

function paddingAxis(rule: StyleRule, axis: 'x' | 'y'): number {
  const shorthand = declarationFor(rule, 'padding')
  const longhand = declarationFor(rule, `padding-${axis === 'x' ? 'inline' : 'block'}`)
  const single = declarationFor(rule, `padding-${axis === 'x' ? 'left' : 'top'}`)
  const raw = longhand ?? single ?? shorthand
  if (raw === undefined) return 0
  const first = Number.parseFloat(raw)
  return Number.isFinite(first) ? first : 0
}

/** The largest `outline-offset` any focus rule for `subject` asks for. */
export function outlineOffsetFor(rules: StyleRule[], subject: string): number {
  let largest = 0
  for (const rule of rules) {
    if (!isFocusRule(rule)) continue
    if (!subjectsOf(rule.selector).includes(subject)) continue
    if (suppressesOutline(rule)) continue
    const offset = declarationFor(rule, 'outline-offset')
    if (offset === undefined) continue
    const value = Number.parseFloat(offset)
    if (Number.isFinite(value) && value > largest) largest = value
  }
  return largest
}/**
 * Every clipping container whose padding cannot hold the focus ring of the
 * controls inside it. `descendants` names the controls by subject selector, so
 * the caller states which ring has to fit rather than this module guessing at
 * the DOM.
 */
export function findClipRisks(rules: StyleRule[], descendants: Record<string, string[]>): ClipRisk[] {
  const risks: ClipRisk[] = []
  for (const rule of rules) {
    const clippedAxes: Array<'x' | 'y'> = []
    if (overflowAxis(rule, 'x')) clippedAxes.push('x')
    if (overflowAxis(rule, 'y')) clippedAxes.push('y')
    if (clippedAxes.length === 0) continue
    const containerSubjects = subjectsOf(rule.selector)
    let offset = 0
    for (const [container, inside] of Object.entries(descendants)) {
      if (!containerSubjects.includes(container)) continue
      for (const selector of inside) offset = Math.max(offset, outlineOffsetFor(rules, selector))
    }
    if (offset === 0) continue
    const clearance = { x: paddingAxis(rule, 'x'), y: paddingAxis(rule, 'y') }
    const clipped = clippedAxes.some((axis) => clearance[axis] < offset)
    if (clipped) risks.push({ container: rule, clippedAxes, clearance, offset })
  }
  return risks
}
