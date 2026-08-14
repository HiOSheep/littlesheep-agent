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
      '.agent-flow-details-panel,\n.agent-tool-details-panel',
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

  it('keeps brand titles bright while sidebar navigation is a softer white', () => {
    const sidebar = ruleBody('.sidebar-contents')
    const settingsSidebar = ruleBody('.settings-sidebar-contents')

    expect(sidebar).not.toContain('--text: var(--text-strong)')
    expect(sidebar).not.toContain('--muted: var(--text-strong)')
    expect(sidebar).not.toContain('--muted-2: var(--text-strong)')
    expect(settingsSidebar).not.toContain('--text: var(--text-strong)')
    expect(settingsSidebar).not.toContain('--muted-2: var(--text-strong)')
    expect(settingsSidebar).not.toContain('--muted: var(--text-strong)')
    expect(settingsSidebar).toContain('color: var(--text)')
    expect(ruleBody('.sidebar-nav-button')).toContain('color: var(--text)')
    expect(ruleBody('.sidebar-section-toggle')).toContain('color: var(--text)')
    expect(ruleBody('.session-item')).toContain('color: var(--text)')
    expect(ruleBody('.project-row-arrow')).toContain('color: var(--text)')
    expect(ruleBody('.settings-nav-group-title')).toContain('color: var(--text)')
    expect(ruleBody('.settings-nav-item')).toContain('color: var(--text)')
    expect(ruleBody('.settings-nav-item strong')).toContain('color: var(--text)')
    expect(ruleBody('.settings-nav-arrow')).toContain('color: var(--text)')
    expect(ruleBody('.settings-nav-item small')).toContain('color: var(--muted)')
    expect(ruleBody('.brand-subtitle')).toContain('color: var(--muted)')
    expect(ruleBody('.brand-title')).toContain('color: var(--text-strong)')
    expect(ruleBody('.sidebar-svg-icon')).toContain('stroke: currentColor')
  })

  it('keeps session titles inside a padded line box before clipping', () => {
    const title = ruleBody('.session-title')

    expect(title).toContain('display: block')
    expect(title).toContain('padding-block: 1px')
    expect(title).toContain('font-weight: 400')
    expect(title).toContain('line-height: 18px')
    expect(title).toContain('overflow: hidden')
  })

  it('uses the regular conversation-title weight across sidebar navigation copy', () => {
    for (const selector of [
      '.sidebar-nav-button',
      '.sidebar-section-toggle',
      '.project-row-title',
      '.settings-nav-group-title',
      '.settings-nav-item strong',
    ]) {
      expect(ruleBody(selector)).toContain('font-weight: 400')
    }
  })

  it('pixel-aligns centered settings and direct-module text surfaces', () => {
    expect(ruleBody('.settings-workspace-body')).toContain('justify-content: flex-start')
    expect(ruleBody('.direct-module-workspace')).toContain('justify-content: flex-start')
    expect(ruleBody('.settings-page-transition')).toContain('round(nearest')
    expect(ruleBody('.direct-module-page')).toContain('round(nearest')
  })

  it('locks both workspace controls to the tab row center line', () => {
    const rowControls = ruleBody('.workspace-tab-row-control')
    const actions = ruleBody('.workspace-panel-actions')
    const cornerToggle = ruleBody('.workspace-panel-corner-toggle')

    expect(rowControls).toContain('position: absolute')
    expect(rowControls).toContain('top: var(--workspace-tab-row-inset)')
    expect(rowControls).toContain('height: var(--workspace-tab-row-height)')
    expect(actions).toContain('right: 41px')
    expect(cornerToggle).toContain('right: 12px')
    expect(actions).not.toContain('top:')
    expect(cornerToggle).not.toContain('top:')
  })

  it('keeps workspace tab text and glyphs on one centered row without clipping descenders', () => {
    const strip = ruleBody('.workspace-tab-strip')
    const tab = ruleBody('.workspace-active-item')
    const label = ruleBody('.workspace-active-label')
    const labelText = ruleBody('.workspace-active-label-text')
    const close = ruleBody('.workspace-active-close')

    expect(strip).toContain('height: var(--workspace-tab-row-height)')
    expect(tab).toContain('height: 26px')
    expect(tab).not.toContain('height: auto')
    expect(tab).not.toContain('min-height:')
    expect(tab).toContain('padding: 4px')
    expect(tab).toContain('border: 0')
    expect(tab).toContain('--workspace-tab-fill: var(--bg)')
    expect(tab).toContain('background: transparent')
    expect(tab).toContain('color: var(--text)')
    expect(tab).toContain('font-family: var(--font)')
    expect(tab).toContain('font-size: 13px')
    expect(tab).toContain('font-weight: 400')
    expect(tab).toContain('line-height: 18px')
    const activeTab = ruleBody('.workspace-active-item:hover,\n.workspace-active-item:focus-visible,\n.workspace-active-item.active')
    expect(activeTab).toContain('--workspace-tab-fill: var(--control-hover)')
    expect(activeTab).toContain('color: var(--text)')
    expect(activeTab).toContain('background: var(--control-hover)')
    expect(label).toContain('display: block')
    expect(label).toContain('line-height: 18px')
    expect(label).not.toContain('text-overflow: ellipsis')
    expect(labelText).toContain('width: max-content')
    expect(styles).toContain('.workspace-active-label.is-overflowing::before,\n.workspace-active-label.is-overflowing::after')
    expect(styles).toContain('transition-duration: var(--workspace-tab-label-scroll-duration)')
    expect(styles).toContain('transition-timing-function: linear')
    expect(styles).toContain('.workspace-active-item > .workspace-panel-svg-icon,\n.workspace-active-item > .workspace-tree-glyph-icon')
    expect(close).toContain('align-self: center')
    expect(close).toContain('justify-self: center')
  })

  it('centers approval labels', () => {
    const actions = ruleBody('.approval-actions')
    const action = ruleBody('.approval-action')

    expect(actions).toContain('align-items: center')
    expect(action).toContain('box-sizing: border-box')
    expect(action).toContain('height: 34px')
    expect(action).toContain('padding: 0 12px 4px')
    expect(action).toContain('letter-spacing: 0')
    expect(action).toContain('line-height: 18px')
    expect(action).toContain('text-align: center')
  })

  it('keeps the shared content entrance animation transform-free', () => {
    expect(ruleBody('@keyframes content-fade-in')).not.toContain('transform:')
  })
})
