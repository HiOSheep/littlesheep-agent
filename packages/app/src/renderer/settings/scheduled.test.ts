import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

function readSettingsFile(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), 'utf8')
}

describe('scheduled page placeholder', () => {
  it('keeps no control that cannot do anything yet', async () => {
    const page = await readSettingsFile('scheduled.tsx')

    expect(page).not.toContain('settings-filter-pill')
    expect(page).not.toContain('role="toolbar"')
    expect(page).not.toContain('<button')
    expect(page).not.toContain('onClick')
  })

  it('reports the capability as unavailable instead of claiming an empty list', async () => {
    const page = await readSettingsFile('scheduled.tsx')

    expect(page).toContain('功能尚未接入')
    expect(page).toContain('还没有接入 Runtime')
    expect(page).not.toContain('暂无已安排任务')
    // An empty-data claim would need a connected capability behind it.
    expect(page).not.toContain('暂无')
  })

  it('marks the entry as unavailable wherever it is offered', async () => {
    const [navigation, directModule, home] = await Promise.all([
      readSettingsFile('navigation.ts'),
      readSettingsFile('direct-module.tsx'),
      readSettingsFile('home.tsx'),
    ])

    expect(navigation).toContain("title: '已安排', desc: '计划任务尚未接入'")
    expect(navigation).not.toContain('计划任务与自动执行')
    // Settings overview, the direct module page and the sidebar all reach the
    // same page component, so they cannot disagree about its state.
    expect(home).toContain('SETTINGS_NAV_GROUPS')
    expect(directModule).toContain("if (page === 'scheduled') return <SettingsScheduledPage />")
  })
})
