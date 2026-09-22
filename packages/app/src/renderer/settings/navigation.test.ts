import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { SETTINGS_NAV_GROUPS } from './navigation'

function readSettingsFile(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), 'utf8')
}

/** Every page id in the SettingsPage union. */
async function declaredSettingsPages(): Promise<string[]> {
  const types = await readSettingsFile('types.ts')
  const union = types.match(/export type SettingsPage =([^\n]+)/u)?.[1] ?? ''
  return [...union.matchAll(/'([^']+)'/gu)].map((match) => match[1]!)
}

describe('settings page identity', () => {
  it('lists every settings page exactly once in the navigation groups', async () => {
    const declared = await declaredSettingsPages()
    const listed = SETTINGS_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.page))

    expect(new Set(listed).size).toBe(listed.length)
    // 'home' is the settings root: it has a navigation row like every other page.
    expect([...listed].sort()).toEqual([...declared].sort())
  })

  it('keeps every settings page restorable after a restart', async () => {
    const declared = await declaredSettingsPages()
    const persistentState = await readFile(
      new URL('../app-shell/persistent-state.ts', import.meta.url),
      'utf8',
    )
    const restorableBlock = persistentState.match(/const SETTINGS_PAGES = new Set<SettingsPage>\(\[([\s\S]*?)\]\)/u)?.[1] ?? ''
    const restorable = [...restorableBlock.matchAll(/'([^']+)'/gu)].map((match) => match[1]!)

    expect([...restorable].sort()).toEqual([...declared].sort())
  })

  it('renders every declared page in the settings workspace', async () => {
    const declared = await declaredSettingsPages()
    const [workspace, directModule, types] = await Promise.all([
      readSettingsFile('workspace.tsx'),
      readSettingsFile('direct-module.tsx'),
      readSettingsFile('types.ts'),
    ])
    const directModulePages = [...(types.match(/export type DirectModulePage = Extract<SettingsPage,([^\n]+)/u)?.[1] ?? '')
      .matchAll(/'([^']+)'/gu)].map((match) => match[1]!)
    const explicitDirectPages = [...directModule.matchAll(/page === '([^']+)'/gu)].map((match) => match[1]!)
    // The last branch is the documented default (plugins), so it carries no id.
    const defaultDirectPage = /return <SettingsPluginsPage \/>/u.test(directModule) ? 'plugins' : ''

    const missing = declared.filter((page) => {
      if (page === 'home') return !workspace.includes("page === 'home'")
      // Direct-module pages are reached through one shared branch and mapped by id.
      if (directModulePages.includes(page)) {
        return !explicitDirectPages.includes(page) && page !== defaultDirectPage
      }
      return !workspace.includes(`'${page}'`)
    })

    expect(missing).toEqual([])
    expect(workspace).toContain('isDirectModulePage(page) && <DirectModulePageContent page={page} />')
  })
})

describe('settings information architecture', () => {
  it('gives display density its own page instead of hiding it under Agent behaviour', async () => {
    const [appearance, agentProfile, navigation] = await Promise.all([
      readSettingsFile('appearance.tsx'),
      readSettingsFile('agent-profile.tsx'),
      readSettingsFile('navigation.ts'),
    ])

    expect(appearance).toContain('readConversationDisplayMode')
    expect(appearance).toContain("role=\"radiogroup\" aria-label=\"对话显示模式\"")
    expect(appearance).toContain('它改变信息怎么展示，不改变 Agent 行为或权限')
    // The behaviour page keeps behaviour and permissions, not display density.
    expect(agentProfile).not.toContain('readConversationDisplayMode')
    expect(agentProfile).not.toContain('writeConversationDisplayMode')
    expect(agentProfile).toContain('权限仍由输入栏的权限模式单独控制')
    expect(navigation).toContain("title: '界面', desc: '对话显示密度与显示偏好'")
    expect(navigation).toContain("title: 'Agent 行为'")
  })

  it('collapses the compression threshold behind an advanced disclosure', async () => {
    const agentProfile = await readSettingsFile('agent-profile.tsx')
    const disclosure = agentProfile.match(/<details className="settings-advanced">([\s\S]*?)<\/details>/u)?.[1] ?? ''

    expect(disclosure).toContain('压缩触发阈值')
    expect(disclosure).toContain('aria-label="上下文压缩触发阈值"')
    // The threshold row lives inside the disclosure, not next to it.
    expect(agentProfile.indexOf('settings-policy-row')).toBeGreaterThan(agentProfile.indexOf('settings-advanced'))
  })

  it('documents the entry → page → return mapping for user-visible modules', async () => {
    const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8')

    expect(readme).toContain('入口 → 页面 → 返回目标')
    for (const name of ['记忆树', '已安排', '插件', '归档', '技能', '外部渠道', '界面']) {
      expect(readme, name).toContain(name)
    }
  })

  it('names the shared modules the same way from the sidebar, the overview and the module page', async () => {
    const [quickNav, directModule] = await Promise.all([
      readFile(new URL('../sidebar/quick-nav.tsx', import.meta.url), 'utf8'),
      readSettingsFile('direct-module.tsx'),
    ])
    // Reads the label map textually: importing the page module would pull the
    // real views (and the Local App API client) into this node-environment test.
    const labels = new Map(
      [...directModule.matchAll(/if \(page === '([^']+)'\) return '([^']+)'/gu)].map((m) => [m[1]!, m[2]!]),
    )
    labels.set('plugins', directModule.match(/return '([^']+)'\n\}/u)?.[1] ?? '')
    const navTitle = (page: string) => SETTINGS_NAV_GROUPS
      .flatMap((group) => group.items)
      .find((item) => item.page === page)?.title

    for (const page of ['memoryTree', 'scheduled', 'plugins']) {
      const label = labels.get(page)
      expect(label, `directModuleLabel(${page})`).toBeTruthy()
      // The sidebar button opens this module page and shows the same name.
      expect(quickNav).toContain(`label="${label}"`)
      expect(quickNav).toContain(`onOpenModulePage('${page}')`)
      // The settings overview row uses the same name for the same page.
      expect(navTitle(page), `settings nav title for ${page}`).toBe(label)
    }
  })
})
