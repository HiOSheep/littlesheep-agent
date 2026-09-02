import { describe, expect, it } from 'vitest'
import { readRendererStyleSource } from '../style-source-test-utils'

describe('sidebar section toggle layout', () => {
  it('makes the title area fill the row before the action buttons', async () => {
    const styles = await readRendererStyleSource()
    const toggle = ruleBody(styles, '.sidebar-section-toggle')
    const actions = ruleBody(styles, '.sidebar-section-actions')

    expect(toggle).toContain('display: flex')
    expect(toggle).toContain('flex: 1 1 auto')
    expect(toggle).toContain('width: auto')
    expect(actions).toContain('flex: 0 0 var(--sidebar-action-column)')
  })

  it('removes the title hover surface and reveals the section arrow on row hover', async () => {
    const styles = await readRendererStyleSource()
    const hover = ruleBody(styles, '.sidebar-section-toggle:hover,\n.sidebar-section-toggle:focus-visible')
    const arrow = ruleBody(styles, '.conversation-section .sidebar-section-arrow,\n.project-section .sidebar-section-arrow')
    const rowHover = ruleBody(
      styles,
      '.conversation-section .sidebar-section-header:hover .sidebar-section-arrow,\n.conversation-section .sidebar-section-header:has(:focus-visible) .sidebar-section-arrow,\n.project-section .sidebar-section-header:hover .sidebar-section-arrow,\n.project-section .sidebar-section-header:has(:focus-visible) .sidebar-section-arrow',
    )

    expect(hover).toContain('background: transparent')
    expect(hover).toContain('border-color: transparent')
    expect(arrow).toContain('opacity: 0')
    expect(rowHover).toContain('opacity: 1')
    expect(rowHover).toContain('border-color: currentColor')
  })

  it('uses a single stable height transition for top-level section folding', async () => {
    const styles = await readRendererStyleSource()
    const section = ruleBody(styles, '.sidebar-section')
    const collapsed = ruleBody(styles, '.sidebar-section.collapsed')
    const header = ruleBody(styles, '.sidebar-section-header')
    const projectTree = ruleBody(styles, '.project-tree')
    const projectCollapsed = ruleBody(styles, '.project-section.collapsed .project-tree')
    const sessionList = ruleBody(styles, '.session-list')
    const conversationCollapsed = ruleBody(styles, '.conversation-section.collapsed .session-list')

    expect(section).toContain('max-height: 100%')
    expect(section).toContain('overflow: hidden')
    expect(section).toContain(
      'transition: max-height var(--sidebar-section-motion) var(--sidebar-section-ease)',
    )
    expect(collapsed).toContain('max-height: var(--sidebar-section-collapsed-height)')
    expect(collapsed).not.toContain('flex: 0 0 auto')
    expect(header).toContain('flex: 0 0 var(--sidebar-section-header-height)')
    expect(projectTree).toContain('scrollbar-gutter: stable both-edges')
    expect(projectTree).toContain('overflow-anchor: none')
    expect(projectTree).toContain('min-height: 0')
    expect(projectTree).toContain(
      'width: calc(100% + var(--sidebar-content-inline-inset) - var(--sidebar-scrollbar-edge-gap))',
    )
    expect(projectTree).toContain('padding-right: var(--sidebar-content-inline-inset)')
    expect(projectTree).toContain(
      'transition: opacity var(--sidebar-section-motion) var(--sidebar-section-ease)',
    )
    expect(projectCollapsed).not.toContain('max-height: 0')
    expect(sessionList).toContain('scrollbar-gutter: stable both-edges')
    expect(sessionList).toContain('overflow-anchor: none')
    expect(sessionList).toContain(
      'width: calc(100% + var(--sidebar-content-inline-inset) - var(--sidebar-scrollbar-edge-gap))',
    )
    expect(sessionList).toContain('padding-right: var(--sidebar-content-inline-inset)')
    expect(sessionList).toContain(
      'transition: opacity var(--sidebar-section-motion) var(--sidebar-section-ease)',
    )
    expect(conversationCollapsed).not.toContain('max-height: 0')
  })

  it('keeps project conversations aligned with the project row width', async () => {
    const styles = await readRendererStyleSource()
    const projectSessionList = ruleBody(styles, '.project-session-list')

    // The outer project tree owns the scrollbar gutter. Reserving another
    // gutter here makes every nested conversation row narrower than its
    // project row by one scrollbar width.
    expect(projectSessionList).not.toContain('scrollbar-gutter: stable')
  })

  it('uses translucent sidebar interaction surfaces that preserve the mapped background', async () => {
    const styles = await readRendererStyleSource()
    const root = ruleBody(styles, ':root')
    const navHover = ruleBody(
      styles,
      '.sidebar-nav-button:hover,\n.sidebar-nav-button:focus-visible',
    )
    const navActive = ruleBody(styles, '.sidebar-nav-button.active')
    const sessionHover = ruleBody(
      styles,
      '.session-item:hover,\n.session-item:focus-visible,\n.session-item:has(:focus-visible)',
    )
    const sessionActive = ruleBody(styles, '.session-item.active')
    const menuPanel = ruleBody(styles, '.sidebar-menu-panel')

    expect(root).toContain(
      '--sidebar-interaction-hover: color-mix(in srgb, var(--text) 6%, transparent);',
    )
    expect(root).toContain(
      '--sidebar-interaction-active: color-mix(in srgb, var(--text) 10%, transparent);',
    )
    expect(navHover).toContain('background-color: var(--sidebar-interaction-hover)')
    expect(navActive).toContain('background-color: var(--sidebar-interaction-active)')
    expect(sessionHover).toContain('background-color: var(--sidebar-interaction-hover)')
    expect(sessionActive).toContain('background-color: var(--sidebar-interaction-active)')
    expect(sessionHover).not.toContain('background: var(--control-hover)')
    expect(sessionActive).not.toContain('background: var(--control)')
    expect(root).toContain(
      '--sidebar-menu-surface: rgba(8, 8, 8, 0.78);',
    )
    expect(menuPanel).toContain('background: var(--sidebar-menu-surface)')
    expect(menuPanel).toContain('-webkit-backdrop-filter: blur(18px) saturate(135%)')
    expect(menuPanel).toContain('backdrop-filter: blur(18px) saturate(135%)')
    expect(menuPanel).not.toContain('background: var(--surface-2)')
  })

  it('reuses the sidebar interaction frame for settings navigation and overview rows', async () => {
    const styles = await readRendererStyleSource()
    const settingsNav = ruleBody(styles, '.settings-nav-item')
    const settingsNavHover = ruleBody(
      styles,
      '.settings-nav-item:hover,\n.settings-nav-item:focus-visible',
    )
    const settingsNavActive = ruleBody(styles, '.settings-nav-item.active')
    const overviewRow = ruleBody(styles, '.settings-overview-row')
    const overviewRowHover = ruleBody(
      styles,
      '.settings-overview-row:hover,\n.settings-overview-row:focus-visible',
    )

    expect(settingsNav).toContain('border: 1px solid transparent')
    expect(settingsNav).toContain('border-radius: var(--radius-ui)')
    expect(settingsNavHover).toContain('background-color: var(--sidebar-interaction-hover)')
    expect(settingsNavHover).toContain('border-color: var(--border-strong)')
    expect(settingsNavActive).toContain('background-color: var(--sidebar-interaction-active)')
    expect(overviewRow).toContain('border: 0')
    expect(overviewRow).toContain('border-radius: var(--radius-ui)')
    expect(overviewRowHover).toContain('background-color: var(--sidebar-interaction-hover)')
    expect(overviewRowHover).not.toContain('border-color')
  })
})

function ruleBody(styles: string, selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start, `missing CSS rule: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = styles.indexOf('\n}', start)
  expect(end, `unterminated CSS rule: ${selector}`).toBeGreaterThan(start)
  return styles.slice(start, end)
}
