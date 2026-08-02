import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'

let styles = ''

beforeAll(async () => {
  styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8')
})

function ruleBody(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start, `${selector} rule should exist`).toBeGreaterThanOrEqual(0)
  const end = styles.indexOf('\n}', start)
  expect(end, `${selector} rule should close`).toBeGreaterThan(start)
  return styles.slice(start, end)
}

describe('frontend font rendering baseline', () => {
  it('does not keep persistent text surfaces in forced 3D compositor layers', () => {
    for (const selector of [
      '.primary-workspace',
      '.settings-workspace',
      '.memory-file-row',
      '.sidebar',
      '.window-shell.sidebar-collapsed .sidebar,\n.window-shell.sidebar-drag-collapsed .sidebar',
      '.sidebar-contents',
      '.settings-sidebar',
      '.window-shell.sidebar-collapsed .settings-sidebar,\n.window-shell.sidebar-drag-collapsed .settings-sidebar',
      '.settings-sidebar-contents',
      '.project-tree',
      '.project-session-list',
      '.session-list',
      '.sidebar-feature-panel',
      '.sidebar-feature-content',
      '.workspace-files-navigator',
      '.workspace-files-navigator-inner',
      '.workspace-add-panel',
      '.add-menu-panel',
      '.workspace-empty-launcher-item',
      '.workspace-tree-row',
      '.message-file-card',
      '.attachment-preview-card',
      '.chat',
      '.window-shell.workspace-panel-fullscreen .chat,\n.window-shell.workspace-panel-drag-fullscreen .chat',
      '.workspace-panel',
      '.workspace-panel-contents',
      '.window-shell.workspace-panel-collapsed .workspace-panel-contents,\n.window-shell.workspace-panel-drag-collapsed .workspace-panel-contents',
      '.workspace-panel-reopen-label',
      '.settings-entry-label',
      '.settings-entry-bridge-label',
      '.task-progress-anchor',
      '.task-progress-popover',
      '.context-usage-popover-shell',
      '.context-usage-popover',
      '.runtime-picker-panel',
      '.runtime-menu-shell',
      '.runtime-menu-shell .runtime-submenu',
      '.model-picker-panel',
      '.floating-help-tip',
      '.presence-layer .dialog',
      '.settings-entry-bridge',
      '.approval-presence .approval-prompt',
      '.project-creator-dialog',
      '.project-create-panel',
      '.is-running',
      '.activity-live',
      '.archive-child-list',
      '.plugin-trust-confirmation',
      '.plugin-list-details',
      '.trace-body',
      '.assistant-turn-process,\n.activity-disclosure-body,\n.activity-command-body',
    ]) {
      const body = ruleBody(selector)
      expect(body).not.toMatch(
        /(?:^|\s)transform\s*:|backface-visibility|will-change\s*:|transition(?:-property)?\s*:[^;]*\btransform\b/u,
      )
    }
  })

  it('does not paint-contain the settings text surfaces', () => {
    for (const selector of ['.settings-workspace-body', '.direct-module-workspace']) {
      expect(ruleBody(selector)).not.toContain('contain: paint')
    }
  })

  it('keeps absolute pixel font sizes on the whole CSS pixel grid', () => {
    expect(styles).not.toMatch(/font-size:\s*\d+\.\d+px/u)
  })

  it('prefers Windows UI-optimized Latin and Chinese fonts', () => {
    expect(styles).toContain('"Segoe UI Variable Text", "Microsoft YaHei UI"')
    expect(ruleBody('body')).toContain('font-synthesis: none')
  })

  it('keeps Chinese sidebar labels inside a padded line box before clipping', () => {
    const button = ruleBody('.sidebar-nav-button')
    const label = ruleBody('.sidebar-nav-label')

    expect(button).toContain('line-height: 18px')
    expect(label).toContain('display: block')
    expect(label).toContain('padding-block: 1px')
    expect(label).toContain('line-height: 18px')
    expect(label).toContain('overflow: hidden')
  })

  it('keeps session titles inside a padded line box before clipping', () => {
    const title = ruleBody('.session-title')

    expect(title).toContain('display: block')
    expect(title).toContain('padding-block: 1px')
    expect(title).toContain('line-height: 18px')
    expect(title).toContain('overflow: hidden')
  })

  it('pixel-aligns centered settings and direct-module text surfaces', () => {
    expect(ruleBody('.settings-workspace-body')).toContain('justify-content: flex-start')
    expect(ruleBody('.direct-module-workspace')).toContain('justify-content: flex-start')
    expect(ruleBody('.settings-page-transition')).toContain('round(nearest')
    expect(ruleBody('.direct-module-page')).toContain('round(nearest')
  })

  it('anchors workspace controls independently from changing content padding', () => {
    const actions = ruleBody('.workspace-panel-actions')

    expect(actions).toContain('position: absolute')
    expect(actions).toContain('top: 14px')
    expect(actions).toContain('right: 41px')
    expect(actions).toContain('margin: 0')
  })

  it('keeps workspace tab text and glyphs on one centered row without clipping descenders', () => {
    const tab = ruleBody('.workspace-active-item')
    const label = ruleBody('.workspace-active-label')
    const close = ruleBody('.workspace-active-close')

    expect(tab).toContain('height: 30px')
    expect(tab).toContain('line-height: 18px')
    expect(label).toContain('display: block')
    expect(label).toContain('padding-block: 1px')
    expect(label).toContain('line-height: 18px')
    expect(styles).toContain('.workspace-active-item > .workspace-panel-svg-icon,\n.workspace-active-item > .workspace-tree-glyph-icon')
    expect(close).toContain('align-self: center')
    expect(close).toContain('justify-self: center')
  })

  it('centers approval labels and keeps the danger fill at 75 percent opacity', () => {
    const actions = ruleBody('.approval-actions')
    const action = ruleBody('.approval-action')
    const danger = ruleBody('.approval-action.primary.danger')

    expect(actions).toContain('align-items: center')
    expect(action).toContain('box-sizing: border-box')
    expect(action).toContain('height: 34px')
    expect(action).toContain('padding: 0 12px 4px')
    expect(action).toContain('letter-spacing: 0')
    expect(action).toContain('line-height: 18px')
    expect(action).toContain('text-align: center')
    expect(danger).toContain('background: rgba(201, 77, 77, 0.75)')
  })

  it('keeps the shared content entrance animation transform-free', () => {
    expect(ruleBody('@keyframes content-fade-in')).not.toContain('transform:')
  })
})
