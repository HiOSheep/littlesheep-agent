import { describe, expect, it } from 'vitest'
import { SettingsPage } from './types'
import {
  LEGACY_SETTINGS_PAGE_GROUPS,
  REMOVED_SETTINGS_PAGE_IDS,
  RENAMED_SETTINGS_PAGE_IDS,
  SETTINGS_HOME_COMMON_PAGES,
  SETTINGS_NAV_GROUPS,
  SETTINGS_REACHABLE_WITHIN_SELECTIONS,
  commonSettingsNavGroups,
  filterSettingsNavGroups,
  resolveSettingsPage,
  settingsDestination,
  settingsSearchNavGroups,
} from './navigation'

/**
 * The settings entry inventory as of the S1 reorganisation (2026-09-27): the five
 * groups and fifteen entries the taskbook counted, written out explicitly so that
 * dropping one of them fails this test instead of silently disappearing.
 */
const S1_ENTRY_INVENTORY: Array<{ page: SettingsPage; title: string }> = [
  // 通用 (was the overloaded group; now display + runtime basics)
  { page: 'home', title: '总览' },
  { page: 'application', title: '应用与后台' },
  { page: 'appearance', title: '界面' },
  { page: 'agent', title: 'Agent 行为' },
  { page: 'api', title: '模型供应商' },
  { page: 'web', title: '网络检索' },
  { page: 'storage', title: '存储与数据' },
  { page: 'browser', title: '内置浏览器' },
  { page: 'developmentEnvironments', title: '开发环境' },
  // 工作
  { page: 'scheduled', title: '已安排' },
  { page: 'archive', title: '归档' },
  // 记忆
  { page: 'memoryTree', title: '记忆树' },
  // 扩展
  { page: 'plugins', title: '插件' },
  { page: 'skills', title: '技能' },
  // 连接
  { page: 'channels', title: '外部渠道' },
]

/** What the taskbook asks the four groups to contain (§2), as page ids. */
const S1_EXPECTED_GROUPS: Array<{ title: string; pages: SettingsPage[] }> = [
  { title: '通用', pages: ['home', 'appearance', 'application'] },
  { title: '模型与行为', pages: ['api', 'agent'] },
  { title: '连接与扩展', pages: ['web', 'browser', 'plugins', 'skills', 'channels'] },
  { title: '存储与环境', pages: ['storage', 'developmentEnvironments'] },
]

/**
 * The pages a user is expected to reach from the settings entry itself: the old
 * fifteen minus the unconnected scheduled placeholder, which now lives only in the
 * search index. This is the fixture that proves "原有可用功能均有去向".
 */
const S1_COMMON_NAVIGATION_PAGES: SettingsPage[] = S1_ENTRY_INVENTORY
  .map((entry) => entry.page)
  .filter((page) => page !== 'scheduled')

function navTitles(): Map<SettingsPage, string> {
  return new Map(SETTINGS_NAV_GROUPS.flatMap((group) => group.items).map((item) => [item.page, item.title]))
}

/**
 * Replays the click path a user takes: selection 1 opens the settings workspace from
 * its entry, and each further selection is either a sidebar row or a search result.
 * `sidebarPages` is the subset reachable by clicking, without typing anything.
 */
function reachPathsFromSettingsEntry(): { paths: Map<SettingsPage, string[]>; sidebarPages: SettingsPage[] } {
  const paths = new Map<SettingsPage, string[]>()
  const settingsEntry = '设置'
  const sidebar = commonSettingsNavGroups().flatMap((group) => group.items)
  for (const item of sidebar) {
    const previous = paths.get(item.page)
    const path = [settingsEntry, item.title]
    if (!previous || path.length < previous.length) paths.set(item.page, path)
  }
  // The settings search is the second selection of the same walk: type a word, click the hit.
  for (const item of settingsSearchNavGroups().flatMap((group) => group.items)) {
    const hits = filterSettingsNavGroups(item.title).flatMap((group) => group.items)
    if (!hits.some((hit) => hit.page === item.page)) continue
    const previous = paths.get(item.page)
    const path = [settingsEntry, `搜索“${item.title}”`]
    if (!previous || path.length < previous.length) paths.set(item.page, path)
  }
  return { paths, sidebarPages: sidebar.map((item) => item.page) }
}

describe('settings information architecture (S1)', () => {
  it('keeps the fifteen-entry inventory and gives every page exactly one destination', () => {
    const destinations = S1_ENTRY_INVENTORY.map((entry) => settingsDestination(entry.page))

    expect(destinations.filter(Boolean)).toHaveLength(S1_ENTRY_INVENTORY.length)
    expect(new Set(destinations.map((destination) => destination?.group)).size).toBeGreaterThanOrEqual(4)
    // Every inventory entry keeps its name: the sidebar, the search index and the
    // page heading still call the same thing by the same name.
    const titles = navTitles()
    for (const entry of S1_ENTRY_INVENTORY) {
      expect(titles.get(entry.page), `${entry.page} keeps its title`).toBe(entry.title)
    }
  })

  it('replaces the overloaded 通用 group with the four groups from the taskbook', () => {
    for (const expected of S1_EXPECTED_GROUPS) {
      const group = SETTINGS_NAV_GROUPS.find((candidate) => candidate.title === expected.title)
      expect(group, `group ${expected.title}`).toBeTruthy()
      expect(group!.items.map((item) => item.page)).toEqual(expected.pages)
    }
    // The old catch-all loaded nine entries; the new 通用 holds the three basics.
    expect(SETTINGS_NAV_GROUPS.find((group) => group.title === '通用')!.items).toHaveLength(3)
    // No page is listed twice, so no two groups can disagree about where a page lives.
    const listed = SETTINGS_NAV_GROUPS.flatMap((group) => group.items).map((item) => item.page)
    expect(new Set(listed).size).toBe(listed.length)
  })

  it('renders the sidebar exactly as the four groups plus the work modules', () => {
    // Measured in the real window (1280x840, 2026-09-27): these are the group titles
    // and rows the sidebar actually shows before anything is typed.
    expect(commonSettingsNavGroups().map((group) => group.title))
      .toEqual([...S1_EXPECTED_GROUPS.map((group) => group.title), '工作模块'])
    expect(commonSettingsNavGroups().flatMap((group) => group.items).map((item) => item.title)).toEqual([
      '总览', '界面', '应用与后台',
      '模型供应商', 'Agent 行为',
      '网络检索', '内置浏览器', '插件', '技能', '外部渠道',
      '存储与数据', '开发环境',
      '归档', '记忆树',
    ])
  })

  it('moves the unconnected scheduled placeholder out of the common navigation but keeps it searchable', () => {
    const common = commonSettingsNavGroups().flatMap((group) => group.items).map((item) => item.page)
    const searchable = settingsSearchNavGroups().flatMap((group) => group.items).map((item) => item.page)
    const scheduled = SETTINGS_NAV_GROUPS
      .flatMap((group) => group.items)
      .find((item) => item.page === 'scheduled')

    expect(common).not.toContain('scheduled')
    expect(searchable).toContain('scheduled')
    expect(scheduled?.searchOnly).toBe(true)
    // It keeps the name and the "not connected" description wherever it is offered.
    expect(scheduled?.title).toBe('已安排')
    expect(scheduled?.desc).toBe('计划任务尚未接入')
    expect(filterSettingsNavGroups('已安排').flatMap((group) => group.items).map((item) => item.page))
      .toEqual(['scheduled'])
  })

  it('keeps 归档 and 记忆树 as reachable work-module entries', () => {
    const common = commonSettingsNavGroups().flatMap((group) => group.items).map((item) => item.page)

    expect(common).toContain('archive')
    expect(common).toContain('memoryTree')
    // They sit in their own group instead of being mixed into the configuration pages.
    const work = SETTINGS_NAV_GROUPS.find((group) => group.title === '工作模块')
    expect(work?.items.map((item) => item.page)).toEqual(['archive', 'memoryTree'])
  })

  it('reaches every common setting within two selections from the settings entry', () => {
    const { paths, sidebarPages } = reachPathsFromSettingsEntry()
    const unreachable = S1_COMMON_NAVIGATION_PAGES.filter((page) => !paths.has(page))

    expect(unreachable).toEqual([])
    for (const page of S1_COMMON_NAVIGATION_PAGES) {
      expect(paths.get(page)!.length, `path to ${page}`).toBeLessThanOrEqual(SETTINGS_REACHABLE_WITHIN_SELECTIONS)
    }
    // The unconnected placeholder is not claimed as a common setting: it needs the
    // search box, while every common setting is one plain click away from the sidebar.
    expect(sidebarPages).not.toContain('scheduled')
    expect(paths.get('scheduled')).toEqual(['设置', '搜索“已安排”'])
  })

  it('resolves every legacy page identifier instead of dropping it', () => {
    const legacyIds = LEGACY_SETTINGS_PAGE_GROUPS.map((mapping) => mapping.legacyId)

    expect([...legacyIds].sort()).toEqual(S1_ENTRY_INVENTORY.map((entry) => entry.page).sort())
    expect(REMOVED_SETTINGS_PAGE_IDS).toEqual([])
    expect(RENAMED_SETTINGS_PAGE_IDS).toEqual({})

    for (const mapping of LEGACY_SETTINGS_PAGE_GROUPS) {
      const resolved = resolveSettingsPage(mapping.legacyId)
      expect(resolved.page, `legacy id ${mapping.legacyId}`).toBe(mapping.resolvedPage)
      expect(resolved.legacy).toBe(false)
      expect(settingsDestination(mapping.resolvedPage)?.group).toBe(mapping.group)
      expect(settingsDestination(mapping.resolvedPage)?.inCommonNavigation).toBe(!mapping.searchOnly)
    }

    // An identifier that never existed still lands on a real page instead of a blank screen.
    expect(resolveSettingsPage('retired-page-from-2025')).toEqual({ page: 'home', legacy: true })
  })

  it('keeps the overview to a few common entries instead of copying the directory', () => {
    const common = commonSettingsNavGroups().flatMap((group) => group.items).map((item) => item.page)
    const directorySize = settingsSearchNavGroups().flatMap((group) => group.items).length

    expect(SETTINGS_HOME_COMMON_PAGES.length).toBeLessThanOrEqual(5)
    expect(SETTINGS_HOME_COMMON_PAGES.length).toBeLessThan(directorySize / 2)
    for (const page of SETTINGS_HOME_COMMON_PAGES) {
      expect(common, `${page} is a real navigation entry`).toContain(page)
    }
    expect(new Set(SETTINGS_HOME_COMMON_PAGES).size).toBe(SETTINGS_HOME_COMMON_PAGES.length)
    // The overview is not the directory: work modules and rarely used pages stay in the sidebar only.
    expect(SETTINGS_HOME_COMMON_PAGES).not.toContain('home')
    expect(SETTINGS_HOME_COMMON_PAGES).not.toContain('archive')
    expect(SETTINGS_HOME_COMMON_PAGES).not.toContain('memoryTree')
  })
})
