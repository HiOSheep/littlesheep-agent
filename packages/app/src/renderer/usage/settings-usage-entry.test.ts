// O6: the heatmap's settings registration, checked through the products that
// have to find it rather than through a private constant.
//
// The three facts asserted here are the ones a user can observe: the entry is in
// the sidebar under the group the taskbook names, the settings search finds the
// page by the words a user types, and the rendered page carries the same title as
// the entry - so "Token 用量" cannot mean two different pages.
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_SETTINGS_PAGE_GROUPS,
  commonSettingsNavGroups,
  filterSettingsNavGroups,
  settingsDestination,
} from '../settings/navigation'
import { USAGE_SETTINGS_NAV_ITEM } from './settings-usage-entry'

async function readUsageFile(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), 'utf8')
}

describe('usage heatmap settings entry', () => {
  it('sits in the sidebar under 模型与行为', () => {
    const group = commonSettingsNavGroups()
      .find((candidate) => candidate.items.some((item) => item.page === 'usage'))
    expect(group?.title).toBe('模型与行为')
    const item = group?.items.find((candidate) => candidate.page === 'usage')
    expect(item).toMatchObject({ title: 'Token 用量', desc: '跨日用量热力图、日详情与统计口径' })
    expect(settingsDestination('usage')).toMatchObject({ group: '模型与行为', inCommonNavigation: true, searchable: true })
    expect(LEGACY_SETTINGS_PAGE_GROUPS.find((entry) => entry.legacyId === 'usage'))
      .toMatchObject({ resolvedPage: 'usage', group: '模型与行为', searchOnly: false })
  })

  it('is found by the words a user searches for', () => {
    for (const query of ['热力图', '用量', '趋势', 'Token 用量']) {
      const hits = filterSettingsNavGroups(query, commonSettingsNavGroups())
        .flatMap((group) => group.items.map((item) => item.page))
      expect(hits, query).toContain('usage')
    }
  })

  it('renders the page with the same name the entry uses', async () => {
    const page = await readUsageFile('usage-heatmap-page.tsx')
    expect(page).toContain(`<h2>${USAGE_SETTINGS_NAV_ITEM.title}</h2>`)
    // The four states go through the shared primitive, not bespoke markup:
    // loading / empty / unavailable are rendered directly, and the offline pair
    // (failure / unavailable-with-reason) is built by `offlineState`.
    expect(page).toContain("from '../ui/state-view'")
    expect(page).toContain('<StateView state="loading"')
    expect(page).toContain('state="empty"')
    expect(page).toContain('state="unavailable"')
    expect(page).toContain("state: 'failure'")
    expect(page).toContain('reason: error.message')
    // The grid scrolls itself instead of pushing the settings column wider.
    const styles = await readFile(new URL('../styles/16-usage-heatmap.css', import.meta.url), 'utf8')
    expect(styles).toMatch(/\.usage-heatmap-scroll\s*\{[^}]*overflow-x:\s*auto;/u)
    expect(styles).not.toContain('!important')
  })
})
