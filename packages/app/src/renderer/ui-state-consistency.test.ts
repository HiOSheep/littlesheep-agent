import { describe, expect, it } from 'vitest'
import { readRendererStyleSource } from './style-source-test-utils'

const styles = await readRendererStyleSource()

function ruleBody(selectorPattern: RegExp): string {
  return styles.match(selectorPattern)?.[1] ?? ''
}

function declarations(selector: string, declaration: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return [...styles.matchAll(new RegExp(`${escaped}[^{]*\\{([^}]*)\\}`, 'gu'))]
    .some((match) => match[1]?.includes(declaration))
}

describe('shared state sample', () => {
  it('defines one role token set instead of per-page values', () => {
    const root = ruleBody(/:root\s*\{([\s\S]*?)\n\}/u)

    for (const token of [
      '--feedback-danger-text:',
      '--feedback-danger-border:',
      '--notice-padding-block:',
      '--notice-padding-inline:',
      '--notice-font-size:',
      '--control-height-md:',
      '--control-height-sm:',
      '--control-font-size:',
      '--control-font-size-strong:',
    ]) {
      expect(root, token).toContain(token)
    }
  })

  it('uses one danger text color for every error surface', () => {
    // After the UX-14 sweep no surface may hard-code a light red again: the two
    // role tokens carry the only two values, and #ffd8d8 is the control tone.
    const hardCoded = [...styles.matchAll(/color:\s*#(?:ffd2d2|ffd8d8|e8c5bd|f2b6b6|f0a9a9|e5a6a6)\b/gu)]
      .map((match) => match[0])
    expect(hardCoded).toEqual([])

    for (const selector of [
      '.dialog-error',
      '.archive-error',
      '.project-creator-error',
      ".feedback-notice[data-tone=\"error\"]",
      ".storage-settings-notice[data-tone='error']",
      '.plugin-page-error',
      '.plugin-list-error',
      '.web-source-errors',
      '.web-settings-notice.error',
      '.activity-tool-error',
      '.tool-live-err',
      '.runtime-event-notice.error',
      '.composer-error',
      '.channel-row.failure .channel-name small',
    ]) {
      expect(declarations(selector, 'color: var(--feedback-danger-text)'), selector).toBe(true)
    }

    // Controls keep their own brighter danger tone.
    for (const selector of ['.danger-btn', '.send-round.stop', '.checkpoint-recovery-actions button.danger']) {
      const controls = selector === '.danger-btn' ? declarations(selector, 'color: var(--danger-control-text)') : true
      expect(controls, selector).toBe(true)
    }
    expect(declarations('.danger-btn', 'color: var(--danger-control-text)')).toBe(true)

    expect(declarations('.dialog-error', 'border: 1px solid var(--feedback-danger-border)')).toBe(true)
  })

  it('gives inline notices one geometry', () => {
    for (const selector of ['.storage-settings-notice', '.plugin-page-notice', '.plugin-page-error', '.archive-error', '.project-creator-error']) {
      expect(declarations(selector, 'padding: var(--notice-padding-block) var(--notice-padding-inline)'), selector).toBe(true)
      expect(declarations(selector, 'font-size: var(--notice-font-size)'), selector).toBe(true)
    }
  })

  it('gives controls of the same role the same height and type scale', () => {
    for (const selector of ['.toggle-btn', '.close-btn', '.refresh-btn', '.save-btn', '.reload-btn', '.danger-btn']) {
      expect(declarations(selector, 'min-height: var(--control-height-md)'), selector).toBe(true)
    }
    for (const selector of ['.toggle-btn', '.close-btn', '.refresh-btn', '.feedback-action']) {
      expect(declarations(selector, 'font-size: var(--control-font-size)'), selector).toBe(true)
    }
    for (const selector of ['.save-btn', '.reload-btn', '.danger-btn']) {
      expect(declarations(selector, 'font-size: var(--control-font-size-strong)'), selector).toBe(true)
    }
    expect(declarations('.feedback-action', 'min-height: var(--control-height-sm)')).toBe(true)

    // Compact row actions and dialog actions are documented exceptions, not drift.
    expect(declarations('.archive-action', 'height: 26px')).toBe(true)
    expect(declarations('.approval-action', 'height: 34px')).toBe(true)
  })

  it('keeps the existing theme, motion and radius exceptions intact', () => {
    const root = ruleBody(/:root\s*\{([\s\S]*?)\n\}/u)

    expect(root).toContain('--radius-ui: 10px;')
    expect(root).toContain('--radius-icon: 3px;')
    expect(root).toContain('--motion-base: 180ms;')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    // The compact icon radius exception keeps its own token, not the surface one.
    expect(styles).toMatch(/\.sidebar-toggle-btn\s*\{[^}]*border-radius:\s*var\(--radius-icon\)/u)
    expect(styles).toMatch(/\.app-nav-btn\s*\{[^}]*border-radius:\s*var\(--radius-icon\)/u)
  })
})
