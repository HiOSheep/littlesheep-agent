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

  it('gives each action role one height instead of a per-page value', () => {
    const root = ruleBody(/:root\s*\{([\s\S]*?)\n\}/u)
    expect(root).toContain('--control-height-row: 30px;')

    // Page header actions share the regular control height...
    for (const selector of [
      '.plugin-reload-button',
      '.development-environments-refresh',
      '.archive-refresh',
      '.refresh-btn',
      '.reload-btn',
    ]) {
      expect(declarations(selector, 'min-height: var(--control-height-md)'), selector).toBe(true)
    }

    // ...and compact actions inside a section share the row height.
    for (const selector of [
      '.settings-policy-row button',
      '.storage-settings-row button',
      '.storage-settings-actions button',
      '.web-cache-clear',
      '.ms-feedback-action',
      '.memory-file-save',
      '.provider-remove',
    ]) {
      expect(declarations(selector, 'min-height: var(--control-height-row)'), selector).toBe(true)
    }
  })

  it('gives the same role one disabled tone instead of a per-page opacity', () => {
    const root = ruleBody(/:root\s*\{([\s\S]*?)\n\}/u)
    expect(root).toContain('--control-disabled-opacity: 0.42;')
    expect(root).toContain('--choice-disabled-opacity: 0.58;')

    // Shared control roles, settings-page action buttons and dialog actions.
    for (const selector of [
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
    ]) {
      expect(declarations(selector, 'opacity: var(--control-disabled-opacity)'), selector).toBe(true)
    }

    // Large selection blocks keep the stronger disabled tone through their own
    // token, so the exception is declarative instead of a stray literal.
    expect(declarations('.application-close-policy-list .profile-choice', 'opacity: var(--choice-disabled-opacity)')).toBe(true)
    expect(declarations('.project-parent-picker', 'opacity: var(--choice-disabled-opacity)')).toBe(true)

    // The converged role must not drift back to a literal 0.42. Keyframe
    // animations use their own opacity steps and are not a disabled tone.
    const declarationsOnly = styles.replace(/@keyframes[\s\S]*?\n\}\n/gu, '\n')
    expect(declarationsOnly).not.toMatch(/(?:^|[\s;{])opacity:\s*0\.42;/u)
  })

  it('keeps the monospace stack able to render CJK', () => {
    const root = ruleBody(/:root\s*\{([\s\S]*?)\n\}/u)

    // A mono stack without CJK faces makes the browser fall back per glyph, so a
    // single code block renders two typefaces (Latin mono + a serif CJK fallback)
    // while the surrounding prose uses Microsoft YaHei UI.
    expect(root).toMatch(/--mono:[^;]*"Microsoft YaHei UI"/u)
    // Markdown code takes its typeface from that token, not the browser default.
    expect(declarations('.markdown pre', 'font-family: var(--mono)')).toBe(true)
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
