import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import { readRendererStyleSource } from '../style-source-test-utils'

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

describe('settings workspace surface', () => {
  it('reuses the single app titlebar instead of mounting a second one', async () => {
    const settingsWorkspace = await readFile(new URL('./workspace.tsx', import.meta.url), 'utf8')
    const appView = await readFile(new URL('../app-shell/app-view.tsx', import.meta.url), 'utf8')

    expect(settingsWorkspace).not.toContain('<GlobalTitlebar')
    expect(appView.match(/<GlobalTitlebar\b/g)?.length).toBe(1)
  })

  it('provides searchable settings navigation and a shared settings exit action', async () => {
    const settingsWorkspace = await readFile(new URL('./workspace.tsx', import.meta.url), 'utf8')
    const overlays = await readFile(new URL('../app-shell/overlays-view.tsx', import.meta.url), 'utf8')

    expect(settingsWorkspace).not.toContain('系统能力与本地工作台')
    expect(settingsWorkspace).not.toContain('<small>{item.desc}</small>')
    expect(settingsWorkspace).toContain('className="settings-sidebar-search"')
    expect(settingsWorkspace).toContain('placeholder="搜索设置"')
    expect(settingsWorkspace).toContain('filteredNavGroups')
    expect(settingsWorkspace).toContain('aria-label="退出设置页"')
    expect(settingsWorkspace).toContain('onClick={onCloseSettings}')
    expect(overlays).toContain('onCloseSettings={closeSettingsFromEntry}')
  })

  it('keeps the settings search and exit controls in the sidebar toolbar without edge borders', () => {
    expect(ruleBody('.settings-sidebar-toolbar')).toContain('grid-template-columns: minmax(0, 1fr) auto')
    expect(ruleBody('.settings-sidebar-search')).toContain('background: var(--control)')
    expect(ruleBody('.settings-sidebar-exit')).toContain('border: 0')
    expect(ruleBody('.settings-sidebar-exit:hover,\n.settings-sidebar-exit:focus-visible')).toContain('background: var(--sidebar-interaction-hover)')
    expect(ruleBody('.settings-nav-item > .settings-nav-arrow')).toContain('opacity: 0')
    expect(ruleBody('.settings-nav-item.active > .settings-nav-arrow')).toContain('opacity: 1')
    expect(ruleBody('.settings-nav-arrow path')).toContain('stroke-linecap: round')
    expect(ruleBody('.settings-nav-arrow path')).toContain('stroke-linejoin: round')
  })

  it('uses the ordinary sidebar row geometry for settings navigation', () => {
    const navItem = ruleBody('.settings-nav-item')
    const navGroupItems = ruleBody('.settings-nav-group-items')

    expect(navGroupItems).toContain('padding-left: 8px')
    expect(navItem).toContain('grid-template-columns: minmax(0, 1fr) 18px')
    expect(navItem).toContain('min-height: 28px')
    expect(navItem).toContain('gap: 8px')
    expect(navItem).toContain('padding: 0 7px')
    // The row carries no frame in any state; the shared settings de-framing block owns that, and
    // the row shows hover and active through their fills.
    const deFramed = styles.slice(styles.indexOf('/* Settings frames are off'))
    expect(deFramed).toContain('.settings-nav-item,')
    expect(deFramed).toContain('border: 0;')
    expect(ruleBody('.settings-nav-item:hover,\n.settings-nav-item:focus-visible')).toContain('background-color: var(--sidebar-interaction-hover)')
    expect(ruleBody('.settings-nav-item.active')).toContain('background-color: var(--sidebar-interaction-active)')
  })

  it('keeps the settings surface free of frame lines', () => {
    const deFramed = styles.slice(styles.indexOf('/* Settings frames are off'))

    for (const selector of [
      '.settings-module-search',
      '.settings-filter-pill',
      '.provider-card',
      '.provider-input input',
      '.development-environment-version',
    ]) {
      expect(deFramed).toContain(selector)
    }
    // Semantic strips and the modal frame are deliberately not in that list.
    expect(deFramed).not.toContain('.dialog,')
    expect(deFramed).not.toContain('.approval-prompt.danger')
  })

  it('uses the titlebar code surface for every settings page canvas', () => {
    expect(ruleBody('.window-titlebar')).toContain('background: var(--workspace-code-surface)')

    for (const selector of [
      '.settings-workspace-body',
      '.direct-module-workspace',
      '.settings-page-transition',
    ]) {
      expect(ruleBody(selector)).toContain('background: var(--workspace-code-surface)')
    }
    expect(ruleBody('.settings-workspace')).toContain('background: transparent')
  })

  it('keeps the settings sidebar scrollbar two pixels from the floating frame', () => {
    const root = ruleBody(':root')
    const nav = ruleBody('.settings-nav-section')

    expect(root).toContain('--sidebar-scrollbar-edge-gap: 2px')
    expect(nav).toContain(
      'width: calc(100% + var(--sidebar-content-inline-inset) - var(--sidebar-scrollbar-edge-gap))',
    )
    expect(nav).toContain('padding-right: var(--sidebar-content-inline-inset)')
  })

  /**
   * The four card-geometry defects of 2026-09-28, each pinned at the declaration
   * that caused it. Every value here was measured in a live window first (see
   * `settings/README.md`); these assertions keep the measurement from being undone
   * by a later round that restates the same selector.
   */
  it('draws a row hairline only between two rows', () => {
    const reset = styles.slice(styles.indexOf(
      ':is(.settings-card, .development-environment-list) > :is(.storage-settings-row, .web-settings-row, .web-settings-field, .settings-policy-row, .settings-value-row, .development-environment-row):not(',
    ))
    expect(reset).not.toBe('')
    expect(reset.slice(0, 600)).toContain(':has(+ :is(')
    expect(reset.slice(0, 600)).toContain('border-bottom: 0')
    // A row followed by the card's own notice/empty/action block drew that line even
    // though it was not the last row, which is what `:last-child` could not express.
    expect(reset.slice(0, 600)).not.toContain(':last-child')
  })

  it('draws every card edge once', () => {
    const emptyInCard = ruleBody('.settings-card > .application-background-empty')
    expect(emptyInCard).toContain('border-top: 0')
    expect(emptyInCard).toContain('border-bottom: 0')

    const listCard = ruleBody('.settings-workspace-body :is(.plugin-list, .development-environment-list) > :last-child')
    expect(listCard).toContain('border-bottom: 0')

    // The rows of the development-environment card are card rows like every other
    // settings row, so they do not draw their own frame inside the card's frame.
    const cardRowStart = styles.indexOf(
      '.settings-workspace-body :is(.settings-card, .development-environment-list) > :is(.storage-settings-row, .web-settings-row, .web-settings-field, .settings-policy-row, .development-environment-row)',
    )
    expect(cardRowStart).toBeGreaterThanOrEqual(0)
    const cardRows = styles.slice(cardRowStart, styles.indexOf('}', cardRowStart))
    expect(cardRows).toContain('border: 0')
    expect(cardRows).toContain('background: transparent')

    // The card geometry itself is declared once for both shapes of card.
    const cardGroup = ruleBody('.settings-workspace-body :is(.settings-card, .settings-overview-group-items, .development-environment-list)')
    expect(cardGroup).toContain('border-radius: var(--settings-card-radius)')
  })

  it('lets the switch keep its own shape inside a settings row', () => {
    // `border-radius: var(--radius-floating-panel)` is `0px` in the window layouts that
    // flatten floating panels, so any row-control rule that reaches the switch turns the
    // track into a rectangle. The neighbouring rule already excluded it; this one did not.
    const start = styles.indexOf('.web-settings-row select,')
    const rowControls = styles.slice(start, styles.indexOf('}', start))
    expect(start).toBeGreaterThanOrEqual(0)
    for (const part of [
      '.storage-settings-row > button',
      '.web-settings-row > button',
      '.settings-policy-row > button',
    ]) {
      expect(rowControls, `${part} should exclude the switch`).toContain(`${part}:not(.plugin-switch)`)
    }
    expect(ruleBody('.plugin-switch')).toContain('border-radius: var(--radius-pill)')
  })

  it('gives the runtime page actions the settings row-action role', () => {
    const deFramed = styles.slice(styles.indexOf('/* Settings frames are off'))
    expect(deFramed).toContain('.development-environment-action-row button,')

    const controlStart = styles.indexOf('.settings-workspace-body :is(.storage-settings-row, .storage-settings-actions')
    expect(controlStart).toBeGreaterThanOrEqual(0)
    const control = styles.slice(controlStart, styles.indexOf('}', controlStart))
    expect(control).toContain('.development-environment-action-row')
    expect(control).toContain('border-radius: var(--settings-control-radius)')
  })

  it('centres the shared state view and keeps no settings-only empty twin', () => {
    // The empty state used to be a settings twin of `.state-view` with its own
    // `align-content` fix. V3 moved the settings pages onto the shared view, so the
    // twin is deleted: a page that goes back to a bespoke empty box fails here.
    expect(ruleBody('.state-view')).toContain('align-content: center')
    expect(styles).not.toContain('.settings-module-empty')
  })
})
