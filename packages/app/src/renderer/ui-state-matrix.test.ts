import { readFile } from 'node:fs/promises'
import { readRendererStyleSourceFiles } from './style-source-test-utils'
import { describe, expect, it } from 'vitest'

/**
 * The control state matrix (V3).
 *
 * Hover alone was never the whole story: the renderer had no pressed state at all
 * (measured in the real window: a real `mousePressed` changed zero pixels on the
 * four controls probed), `.plugin-switch` had no pointer state, and the disabled
 * tone was copied into 21 per-role rules - which is how `.danger-btn` ended up
 * overriding its own documented role token with a literal `0.5`.
 *
 * This file measures the matrix against `ui/README.md`:
 *   hover     - per role, in the role's own domain file;
 *   focus     - the app-wide `:focus-visible` ring, extended to the ARIA roles;
 *   pressed   - `styles/13-interaction-states.css`, imported last so a press
 *               outranks the hover fill it has to be distinguished from;
 *   disabled  - one token per role family, applied by one shared rule;
 *   busy      - `aria-busy`, a working state, never a copy of disabled.
 */

const styleFiles = await readRendererStyleSourceFiles()
const stateLayerPath = './styles/13-interaction-states.css'
const styles = styleFiles.map(({ source }) => source).join('')

interface LocatedRule {
  file: string
  selector: string
  body: string
  index: number
}

const allRules: LocatedRule[] = styleFiles.flatMap(({ path, source }) => {
  const withoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
    file: path,
    selector: (match[1] ?? '').replaceAll(/\s+/gu, ' ').trim(),
    body: match[2] ?? '',
    index: match.index ?? 0,
  }))
})

function rulesFor(roleSelector: string, state: ':hover' | ':active' | ':focus-visible'): LocatedRule[] {
  return allRules.filter((rule) => rule.selector.includes(roleSelector) && rule.selector.includes(state))
}

/**
 * CSS specificity (Selectors 4) as a comparable score: an id beats any number of
 * classes, a class/attribute/pseudo-class beats any number of element names, and
 * `:is()` / `:not()` / `:has()` contribute their most specific argument (which is
 * why one shared `:is(...)` rule can outrank every role-specific `:hover` rule).
 * A comma list is scored by its most specific compound, because that is the one
 * that applies when it matches.
 */
function specificity(selector: string): number {
  return Math.max(...splitTopLevel(selector).map((part) => compoundSpecificity(part.trim())))
}

/** Split a selector list on commas that are not inside `:is()` / `:not()` / `:has()`. */
function splitTopLevel(selector: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const character of selector) {
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  parts.push(current)
  return parts.filter((part) => part.trim().length > 0)
}

/** Split one selector part into compounds on combinators outside parentheses. */
function compounds(part: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const character of part.trim()) {
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    if (depth === 0 && /[\s>+~]/u.test(character)) {
      if (current.trim()) out.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (current.trim()) out.push(current.trim())
  return out
}

/** The compound selectors a selector list ends on (what the rule actually styles). */
function subjectCompounds(selector: string): string[] {
  return splitTopLevel(selector).map((part) => compounds(part).at(-1) ?? '')
}

/** The compound selectors a selector list starts at. */
function headCompounds(selector: string): string[] {
  return splitTopLevel(selector).map((part) => compounds(part)[0] ?? '')
}

/** True when the rule's own subject (not a descendant of it) is the role. */
function subjectIncludes(selector: string, role: string): boolean {
  return subjectCompounds(selector).some((compound) => compound.includes(role))
}

/** True when at least one top-level part starts at the role itself. */
function subjectStartsAt(selector: string, role: string): boolean {
  return headCompounds(selector).some((compound) => compound.includes(role))
}

function compoundSpecificity(compound: string): number {
  let rest = compound.replaceAll(/:where\([^)]*\)/gu, '')
  let functional = 0
  for (const match of rest.matchAll(/:(?:is|not|has)\(([^)]*)\)/gu)) {
    const args = splitTopLevel(match[1] ?? '')
    if (args.length > 0) functional += Math.max(...args.map((part) => specificity(part)))
  }
  rest = rest.replaceAll(/:(?:is|not|has)\([^)]*\)/gu, '')
  const ids = (rest.match(/#[\w-]+/gu) ?? []).length * 10_000
  const classes = (rest.match(/\.[\w-]+/gu) ?? []).length * 100
  const attributes = (rest.match(/\[[^\]]*\]/gu) ?? []).length * 100
  const pseudos = (rest.match(/:(?!:)[\w-]+/gu) ?? []).length * 100
  const types = (rest.match(/(?:^|[\s>+~])[a-z][\w-]*/gu) ?? []).length
  return ids + classes + attributes + pseudos + types + functional
}

async function readRendererFile(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

/** Every shared control role the state sample in `ui/README.md` names. */
const CONTROL_ROLES = [
  '.toggle-btn',
  '.close-btn',
  '.refresh-btn',
  '.danger-btn',
  '.dialog-close',
  '.save-btn',
  '.reload-btn',
  '.feedback-action',
  '.icon-btn',
  '.send-round',
  '.plugin-reload-button',
  '.plugin-switch',
  '.split-button-primary',
  '.split-button-chevron',
  '.split-button-menu-item',
  '.settings-policy-row button',
  '.application-background-refresh',
  '.active-run-actions button',
  '.storage-settings-row button',
  '.storage-settings-actions button',
  '.development-environments-refresh',
  '.development-environment-version-remove',
  '.development-environment-action-row button',
  '.development-environment-controls > button',
  '.checkpoint-recovery-header button',
  '.checkpoint-recovery-actions button',
  '.memory-files-icon-button',
  '.memory-file-save',
  '.project-create-submit',
  '.archive-refresh',
  '.archive-action',
] as const

/** Roles that also answer the pointer with a pressed fill. */
const PRESSED_ROLES = [
  ...CONTROL_ROLES,
  '.sidebar-nav-button',
  '.sidebar-menu-item',
  '.sidebar-search-result',
  '.sidebar-section-action',
  '.session-item',
  '.settings-nav-item',
  '.settings-overview-row',
  '.settings-filter-pill',
  '.pill-select',
  '.add-menu-item',
  '.runtime-menu-item',
  '.model-option',
  '.ms-feedback-action',
  '.composer-tab-control',
  '.running-pill',
] as const

describe('control state matrix', () => {
  it('gives every shared control role a pressed state in the shared state layer', () => {
    for (const role of PRESSED_ROLES) {
      const pressed = rulesFor(role, ':active')
      expect(pressed.length, `${role} has no pressed state`).toBeGreaterThan(0)
      for (const rule of pressed) {
        expect(rule.file, `${role} must answer :active from the shared state layer`).toBe(stateLayerPath)
        expect(rule.body, `${role} pressed rule changes nothing`).toMatch(/background|filter/u)
      }
    }
  })

  it('keeps the press stronger than the hover it has to be told apart from', () => {
    // Source order alone is not enough: a domain rule with one extra `:not(…)`
    // clause wins a tie by specificity, which is how a pressed state can exist in
    // the stylesheet and still be invisible in the window. The comparison is made
    // against the *unconditional* hover rules for the role — the ones that start
    // at the role itself.
    for (const role of PRESSED_ROLES) {
      // Only a rule whose *subject* is the control decides that control's own pressed state. A hover
      // rule that targets a descendant (`.session-item:hover .label.is-overflowing .overflowing`) is
      // more specific but paints a different element, so comparing the two says nothing about whether
      // the press is visible — that was a false positive, not a missing pressed state.
      const hover = rulesFor(role, ':hover').filter((rule) => subjectIncludes(rule.selector, role))
      if (hover.length === 0) continue
      const pressed = rulesFor(role, ':active').filter((rule) => subjectIncludes(rule.selector, role))
      expect(pressed.length, `${role} has a hover state but no pressed state`).toBeGreaterThan(0)
      const pressScore = Math.max(...pressed.map((rule) => specificity(rule.selector)))

      const unconditional = hover.filter((rule) => subjectStartsAt(rule.selector, role) && subjectIncludes(rule.selector, role))
      for (const rule of unconditional) {
        const hoverScore = specificity(rule.selector)
        expect(pressScore, `${role} pressed state is outranked by ${rule.selector}`).toBeGreaterThanOrEqual(hoverScore)
        if (pressScore === hoverScore) {
          const order = (entry: LocatedRule) => styleFiles.findIndex(({ path }) => path === entry.file) * 1_000_000 + entry.index
          expect(order(pressed[0]!), `${role} pressed state is declared before ${rule.selector}`).toBeGreaterThan(order(rule))
        }
      }

      // Anything that outranks the press must be a documented exception, not a
      // role fill that happens to be more specific: either it styles a descendant
      // of the role (the row's label / trailing actions), or it only applies while
      // a row drag is locking the list, where every fill is deliberately cleared.
      for (const rule of hover) {
        if (specificity(rule.selector) <= pressScore) continue
        const stylesDescendant = !subjectIncludes(rule.selector, role)
        const dragLock = /body\.(?:sidebar-list-dragging|workspace-tab-dragging)/u.test(rule.selector)
        expect(
          stylesDescendant || dragLock,
          `${rule.selector} outranks the pressed state for ${role}`,
        ).toBe(true)
      }
    }
  })

  it('applies the disabled tone from one rule per role family', () => {
    const sharedDisabled = allRules.filter((rule) => rule.body.includes('opacity: var(--control-disabled-opacity)'))
    expect(sharedDisabled, 'more than one rule may own the disabled tone').toHaveLength(1)
    expect(sharedDisabled[0]!.file).toBe(stateLayerPath)
    const selector = sharedDisabled[0]!.selector
    for (const role of CONTROL_ROLES) {
      expect(selector, `${role} is missing from the shared disabled role list`).toContain(role)
    }
    // The drift this replaced: a later rule silently overriding the role token.
    expect(styles).not.toMatch(/\.danger-btn:disabled[^}]*opacity:\s*0?\.\d/u)
    // The disabled tone itself must never come back as a literal.
    const declarationsOnly = styles.replace(/@keyframes[\s\S]*?\n\}\n/gu, '\n')
    expect(declarationsOnly).not.toMatch(/(?:^|[\s;{])opacity:\s*0\.42;/u)
  })

  it('keeps disabled controls off the pointer and busy controls on the progress cursor', () => {
    expect(styles).toMatch(/\):is\(:disabled, \[aria-disabled='true'\]\)\s*\{\s*cursor: default;/u)
    expect(styles).toMatch(/\[aria-busy='true'\]\s*\{\s*cursor: progress;/u)
    // Busy is a working state: the in-flight segment keeps its presence instead
    // of borrowing the disabled tone.
    expect(styles).toMatch(/\.split-button\.busy \.split-button-primary:disabled\s*\{\s*opacity: 1;/u)
    expect(styles).toMatch(/\.split-button\.busy::after\s*\{[^}]*animation:/u)
  })

  it('keeps keyboard focus visible for the non-button interactive roles', () => {
    const focusRule = allRules.find((rule) => rule.selector.startsWith("button:focus-visible") && rule.body.includes('outline:'))
    expect(focusRule, 'the app-wide focus ring is missing').toBeDefined()
    expect(focusRule!.file).toBe('./styles/03-shell-sidebar.css')
    for (const role of ["a[href]", 'summary', "[role='button']", "[role='menuitem']", "[role='menuitemradio']", "[role='option']", "[role='switch']", "[role='tab']"]) {
      expect(focusRule!.selector, `${role} has no focus ring`).toContain(role)
    }
    // A keyboard user must also see the *control* the ring is on: the ring is a
    // real outline, not a colour-only treatment.
    expect(focusRule!.body).toContain('outline: 2px solid')
  })

  it('distinguishes the four state views without relying on colour', () => {
    for (const state of ['loading', 'unavailable', 'failure', 'empty']) {
      expect(styles, `no .state-view[data-state='${state}'] surface`).toContain(`.state-view[data-state='${state}']`)
    }
    // Loading turns; unavailable is a different frame; failure owns the danger role.
    expect(styles).toMatch(/\.state-view\[data-state='loading'\] \.state-view-ring\s*\{[^}]*animation:/u)
    expect(styles).toMatch(/\.state-view\[data-state='unavailable'\] \.state-view-icon\s*\{[^}]*border-style: dashed;/u)
    expect(styles).toMatch(/\.state-view\[data-state='failure'\] \.state-view-icon\s*\{[^}]*color: var\(--feedback-danger-text\);/u)
    // Empty is the neutral one: it must not borrow the warning or danger roles.
    const emptyRules = allRules.filter((rule) => rule.selector.includes(".state-view[data-state='empty']"))
    for (const rule of emptyRules) {
      expect(rule.body).not.toContain('--danger')
      expect(rule.body).not.toContain('--warning')
    }
    // The loading ring is a circle, so the corner policy has to exempt it.
    expect(styles).toContain(".state-view[data-state='loading'] .state-view-ring,")
  })

  it('publishes the state each shared control is in', async () => {
    const notice = await readRendererFile('./ui/feedback-notice.tsx')
    expect(notice).toContain('className="feedback-icon"')
    expect(notice).toContain('aria-busy={busy ? true : undefined}')
    expect(notice).toContain('toneIcon(feedback.tone)')
    // A failure is an icon and a sentence: never colour alone.
    for (const tone of ['error', 'warning', 'success']) {
      expect(notice, `no glyph for the ${tone} tone`).toContain(`tone === '${tone}'`)
    }
    // A busy retry says why it cannot be used again yet.
    expect(notice).toContain('上一次操作还在进行')

    const danger = await readRendererFile('./ui/danger-confirm.tsx')
    expect(danger).toContain('aria-busy={busy ? true : undefined}')
    expect(danger).toContain('<FailureIcon />')
    expect(danger).toContain("busy ? '删除中…' : '永久删除'")

    const split = await readRendererFile('./ui/split-button.tsx')
    expect(split).toContain('aria-busy={busy ? true : undefined}')
    expect(split).toContain('disabledReason')
    expect(split).toContain('正在执行，完成或失败后可以再用')
  })
})
