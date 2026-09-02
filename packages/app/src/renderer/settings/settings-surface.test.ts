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
    expect(navItem).toContain('border: 1px solid transparent')
    expect(ruleBody('.settings-nav-item:hover,\n.settings-nav-item:focus-visible')).toContain('border-color: var(--border-strong)')
    expect(ruleBody('.settings-nav-item.active')).toContain('border-color: var(--border-strong)')
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
})
