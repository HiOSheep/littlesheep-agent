import { readFile } from 'node:fs/promises'
import { VIEW_STATES, viewStateSpec } from './state-view'
import { describe, expect, it } from 'vitest'

/**
 * The four state views must be distinguishable *as data*, not only in a
 * screenshot: if two states share a role, a busy flag, a disabled flag or a
 * glyph, then no amount of styling can tell them apart, and "this cannot be used
 * here" collapses into "there is nothing here".
 */
describe('view state table', () => {
  it('answers every state with its own signature', () => {
    const signatures = VIEW_STATES.map((state) => {
      const spec = viewStateSpec(state)
      return [spec.role, spec.busy, spec.disabled, spec.icon, spec.requiresReason, spec.allowsAction].join('|')
    })
    expect(new Set(signatures).size).toBe(VIEW_STATES.length)
    expect(VIEW_STATES).toEqual(['loading', 'empty', 'unavailable', 'failure'])
  })

  it('draws four different shapes, so greyscale is enough to tell them apart', () => {
    const icons = VIEW_STATES.map((state) => viewStateSpec(state).icon)
    expect(new Set(icons).size).toBe(VIEW_STATES.length)
  })

  it('interrupts only for a failure and stays polite for the other three', () => {
    expect(viewStateSpec('failure').role).toBe('alert')
    for (const state of ['loading', 'empty', 'unavailable'] as const) {
      expect(viewStateSpec(state).role, state).toBe('status')
    }
  })

  it('marks unavailable as disabled and requires its reason', () => {
    // The two facts that keep "cannot be used" from rendering as "empty".
    expect(viewStateSpec('unavailable').disabled).toBe(true)
    expect(viewStateSpec('unavailable').requiresReason).toBe(true)
    expect(viewStateSpec('empty').disabled).toBe(false)
    expect(viewStateSpec('empty').requiresReason).toBe(false)
  })

  it('marks loading as busy and gives it no action, because the area is already working', () => {
    expect(viewStateSpec('loading').busy).toBe(true)
    expect(viewStateSpec('loading').allowsAction).toBe(false)
    // Failure and empty may each offer the area's one action (retry / next step).
    expect(viewStateSpec('failure').allowsAction).toBe(true)
    expect(viewStateSpec('empty').allowsAction).toBe(true)
  })
})

describe('view state surfaces', () => {
  it('renders the reason for unavailable and the busy flag for loading', async () => {
    const source = await readFile(new URL('./state-view.tsx', import.meta.url), 'utf8')
    expect(source).toContain("props.state === 'unavailable' ? props.reason : null")
    expect(source).toContain('aria-busy={spec.busy ? true : undefined}')
    expect(source).toContain('aria-disabled={spec.disabled ? true : undefined}')
    expect(source).toContain('role={spec.role}')
    // The reason is a visible sentence, not a tooltip: "cannot be used" has to be
    // readable without hovering.
    expect(source).toContain('<p className="state-view-reason">{reason}</p>')
    // One action slot per area, and the caller still owns the control.
    expect(source).toContain('<div className="state-view-action-slot">{props.action}</div>')
  })

  it('keeps the glyph family separate from the frozen icon set', async () => {
    const source = await readFile(new URL('./state-icons.tsx', import.meta.url), 'utf8')
    for (const glyph of ['FailureIcon', 'WarningIcon', 'SuccessIcon', 'InfoIcon', 'UnavailableIcon', 'EmptyIcon']) {
      expect(source, `${glyph} is missing`).toContain(`export function ${glyph}()`)
    }
    // State marks are decoration: the sentence next to them is the announcement.
    expect(source.match(/aria-hidden="true"/gu)?.length).toBe(6)
    // Empty and unavailable are different silhouettes on purpose.
    expect(source).toContain('M4.1 11.9 11.9 4.1')
    expect(source).toContain('M2.4 9.1h3.1l.9 1.7h3.2l.9-1.7h3.1')
  })

  it('does not grow the frozen icon hotspot', async () => {
    // The family file is the sanctioned place for new marks: `icons.tsx` has a
    // hard ceiling in check-repository-hygiene.
    const icons = await readFile(new URL('./icons.tsx', import.meta.url), 'utf8')
    expect(icons).not.toContain('FailureIcon')
    expect(icons).not.toContain('UnavailableIcon')
  })
})
