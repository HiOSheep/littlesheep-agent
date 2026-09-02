import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from './style-source-test-utils'
import { beforeAll, describe, expect, it } from 'vitest'

let styles = ''

beforeAll(async () => {
  styles = await readRendererStyleSource()
})

function ruleBody(selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start, `${selector} rule should exist`).toBeGreaterThanOrEqual(0)
  const end = styles.indexOf('\n}', start)
  expect(end, `${selector} rule should close`).toBeGreaterThan(start)
  return styles.slice(start, end)
}

function directRuleBody(selector: string): string {
  const start = styles.indexOf(`\n${selector} {`)
  expect(start, `${selector} direct rule should exist`).toBeGreaterThanOrEqual(0)
  const end = styles.indexOf('\n}', start)
  expect(end, `${selector} direct rule should close`).toBeGreaterThan(start)
  return styles.slice(start + 1, end)
}

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
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
      '.settings-entry-global',
      '.approval-presence .approval-prompt',
      '.project-creator-dialog',
      '.project-create-panel',
      '.is-running',
      '.activity-live',
      '.archive-child-list',
      '.plugin-trust-confirmation',
      '.plugin-list-details',
      '.trace-body',
      '.agent-tool-details-panel',
    ]) {
      const body = ruleBody(selector)
      expect(body).not.toMatch(
        /(?:^|\s)transform\s*:|backface-visibility|will-change\s*:|transition(?:-property)?\s*:[^;]*\btransform\b/u,
      )
    }
  })

  it('uses two-dimensional whole-surface motion for the floating panels', () => {
    const sidebarSurface = directRuleBody('.sidebar-surface')
    const workspaceSurface = directRuleBody('.workspace-panel-surface')

    expect(sidebarSurface).toContain('transform: translateX(var(--sidebar-surface-translate-x))')
    expect(sidebarSurface).toContain('transform var(--sidebar-collapse-motion) var(--motion-ease)')
    expect(workspaceSurface).toContain('transform: translateX(var(--workspace-panel-surface-translate-x))')
    expect(workspaceSurface).toContain('transform var(--workspace-panel-motion) var(--motion-ease)')
    expect(sidebarSurface).not.toContain('translate3d')
    expect(workspaceSurface).not.toContain('translate3d')
    expect(sidebarSurface).not.toContain('will-change')
    expect(workspaceSurface).not.toContain('will-change')
  })

  it('uses compact borderless browser-style history controls in the titlebar', async () => {
    const back = directRuleBody('.app-nav-btn')
    const arrow = ruleBody('.history-navigation-icon')
    const controls = ruleBody('.app-nav-controls')
    const titlebarControls = ruleBody('.app-nav-controls > .sidebar-toggle-btn,\n.app-nav-controls > .app-nav-btn')
    const titlebar = await source('./sidebar/global-titlebar.tsx')
    const browser = await source('./workspace/browser.tsx')

    expect(back).toContain('width: 24px')
    expect(back).toContain('height: 24px')
    expect(back).toContain('color: var(--muted-2)')
    expect(back).toContain('border: 0')
    expect(controls).toContain('gap: 4px')
    expect(titlebarControls).toContain('border: 0')
    expect(titlebarControls).toContain('outline: 0')
    expect(titlebarControls).toContain('border-radius: var(--radius-ui)')
    expect(titlebarControls).toContain('width: 24px')
    expect(titlebarControls).toContain('height: 24px')
    expect(arrow).toContain('width: 20px')
    expect(arrow).toContain('height: 20px')
    expect(styles).not.toMatch(/\.app-nav-btn\.nav-forward\s*\{[^}]*margin-left:/u)
    expect(titlebar).toContain('<HistoryBackIcon />')
    expect(titlebar).toContain('<HistoryForwardIcon />')
    expect(browser).toContain('<HistoryBackIcon />')
    expect(browser).toContain('<HistoryForwardIcon />')
  })

  it('keeps the sidebar search surface two pixels from the sidebar and borderless inside', () => {
    const panel = ruleBody('.sidebar-feature-panel')
    const header = ruleBody('.sidebar-feature-header')
    const searchBox = ruleBody('.sidebar-search-box')
    const result = ruleBody('.sidebar-search-result')
    const close = ruleBody('.sidebar-feature-close')

    expect(panel).toContain('left: 2px')
    expect(panel).toContain('width: min(460px, calc(100% - 4px))')
    expect(panel).toContain('background: rgba(22, 22, 22, 0.99)')
    expect(panel).toContain('border: 0')
    expect(header).toContain('border-bottom: 0')
    expect(searchBox).toContain('border: 0')
    expect(result).toContain('border: 0')
    expect(close).toContain('border: 0')
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
    expect(ruleBody('.brand-subtitle')).toContain('color: var(--muted)')
    expect(ruleBody('.brand-title')).toContain('color: var(--text-strong)')
    expect(ruleBody('.sidebar-svg-icon')).toContain('stroke: currentColor')
    expect(ruleBody('.sidebar-svg-icon')).toContain('stroke-linecap: round')
    expect(styles).toMatch(/\.workspace-panel-svg-icon path,[\s\S]*?stroke-linejoin: round/u)
    expect(styles).toMatch(/\.workspace-tree-chevron-icon,[\s\S]*?shape-rendering: geometricPrecision/u)
  })

  it('keeps sidebar names padded, faded, and borderless while they scroll', () => {
    const label = ruleBody('.overflowing-label')
    const labelText = ruleBody('.overflowing-label-text')
    const title = ruleBody('.session-title')
    const hoveredItem = ruleBody('.session-item:hover,\n.session-item:focus-visible,\n.session-item:has(:focus-visible)')

    expect(label).toContain('display: block')
    expect(label).toContain('min-width: 0')
    expect(label).toContain('overflow: hidden')
    expect(label).not.toContain('text-overflow: ellipsis')
    expect(labelText).toContain('width: max-content')
    expect(title).toContain('padding-block: 1px')
    expect(title).toContain('font-weight: 400')
    expect(title).toContain('line-height: 18px')
    expect(hoveredItem).toContain('background-color: var(--sidebar-interaction-hover)')
    expect(hoveredItem).not.toContain('border-color')
    expect(styles).toContain('.sidebar-overflowing-label.is-overflowing')
    expect(styles).toContain('-webkit-mask: linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%) -14px 0 / calc(100% + 14px) 100% no-repeat')
    expect(styles).toContain('mask: linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%) -14px 0 / calc(100% + 14px) 100% no-repeat')
    expect(styles).toContain('mask-position: -14px 0')
    expect(styles).toContain('transform: translateX(var(--overflowing-label-offset))')
    expect(styles).toContain('transition-duration: var(--overflowing-label-scroll-duration)')
    expect(styles).toContain('--overflowing-label-hover-delay: 450ms')
    expect(styles).toContain('transition-delay: var(--overflowing-label-hover-delay)')
  })

  it('keeps the new-project dialog and its controls free of edge lines', () => {
    expect(ruleBody('.project-creator-dialog')).toContain('border: 0')
    expect(ruleBody('.project-creator-header')).toContain('border-bottom: 0')
    expect(ruleBody('.project-creator-close')).toContain('border: 0')
    expect(styles).toMatch(
      /\.project-creator-option,\s*\.project-parent-picker\s*\{[^}]*border:\s*0;/u,
    )
    expect(ruleBody('.project-name-input input')).toContain('border: 0')
    expect(ruleBody('.project-create-submit')).toContain('border: 0')
    expect(ruleBody('.project-creator-error')).toContain('border: 0')
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
    const panelAction = ruleBody('.workspace-panel-action')

    expect(rowControls).toContain('position: absolute')
    expect(rowControls).toContain('top: var(--workspace-tab-row-inset)')
    expect(rowControls).toContain('height: var(--workspace-tab-row-height)')
    expect(actions).toContain('var(--workspace-tab-row-height)')
    expect(actions).toContain('var(--workspace-tab-row-gap)')
    expect(cornerToggle).toContain('top: var(')
    expect(cornerToggle).toContain('--workspace-panel-toggle-top')
    expect(cornerToggle).toContain('var(--floating-panel-inset)')
    expect(cornerToggle).toContain('var(--floating-panel-border-width)')
    expect(cornerToggle).toContain('var(--workspace-tab-row-inset)')
    expect(cornerToggle).toContain('right: 12px')
    expect(cornerToggle).toContain('width: var(--workspace-tab-row-height)')
    expect(cornerToggle).toContain('height: var(--workspace-tab-row-height)')
    expect(cornerToggle).toContain('border: 0')
    expect(cornerToggle).toContain('border-radius: var(--radius-ui)')
    expect(actions).toContain('gap: var(--workspace-tab-row-gap)')
    expect(panelAction).toContain('width: var(--workspace-tab-row-height)')
    expect(panelAction).toContain('height: var(--workspace-tab-row-height)')
    expect(panelAction).toContain('border: 0')
    expect(actions).not.toContain('top:')
  })

  it('keeps workspace tab text and glyphs on one centered row without clipping descenders', () => {
    const strip = ruleBody('.workspace-tab-strip')
    const tab = directRuleBody('.workspace-active-item')
    const label = ruleBody('.overflowing-label')
    const labelText = ruleBody('.overflowing-label-text')
    const workspaceLabel = ruleBody('.workspace-active-label')
    const close = ruleBody('.workspace-active-close')
    const addTrigger = ruleBody('.workspace-add-trigger')

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
    expect(tab).toContain('--workspace-tab-glass-fill: color-mix(in srgb, var(--control-hover) 74%, transparent)')
    expect(tab).toContain('-webkit-backdrop-filter: blur(12px) saturate(135%)')
    expect(tab).toContain('backdrop-filter: blur(12px) saturate(135%)')
    const activeTab = ruleBody('.workspace-active-item:hover,\n.workspace-active-item:focus-visible,\n.workspace-active-item.active')
    expect(activeTab).toContain('--workspace-tab-fill: var(--workspace-tab-glass-fill)')
    expect(activeTab).toContain('color: var(--text)')
    expect(activeTab).toContain('background: var(--workspace-tab-glass-fill)')
    expect(activeTab).toContain('box-shadow: 0 6px 16px rgba(0, 0, 0, 0.16)')
    expect(label).toContain('display: block')
    expect(workspaceLabel).toContain('line-height: 18px')
    expect(label).not.toContain('text-overflow: ellipsis')
    expect(labelText).toContain('width: max-content')
    expect(styles).toContain('.workspace-active-label.is-overflowing::before,\n.workspace-active-label.is-overflowing::after')
    expect(styles).toContain('transition-delay: var(--overflowing-label-hover-delay)')
    expect(styles).toContain('transition-duration: var(--overflowing-label-scroll-duration)')
    expect(styles).toContain('transition-timing-function: linear')
    expect(styles).toContain('.workspace-active-item > .workspace-panel-svg-icon,\n.workspace-active-item > .workspace-tree-glyph-icon')
    expect(close).toContain('align-self: center')
    expect(close).toContain('justify-self: center')
    expect(addTrigger).toContain('width: 26px')
    expect(addTrigger).toContain('height: 26px')
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
