// Settings navigation and page composition.
//
// 信息架构（S1，2026-09-27）：设置侧栏按“用户想做什么”分成四组，而不是按内部领域分。
//   通用          —— 每个用户都会碰的显示与运行方式；
//   模型与行为    —— 模型接入与 Agent 行为（上下文参数收在“Agent 行为”的高级设置里）；
//   连接与扩展    —— 需要外部端点或第三方内容的能力；
//   存储与环境    —— 数据落盘位置与本机工具链。
// 归档、记忆树、插件仍是工作模块：侧栏与设置搜索都能到，插件同时保留设置入口。
// “已安排”是未接入的占位页，因此退出常用导航（`searchOnly`），只留在设置搜索索引里。
//
// 这一份数据同时驱动侧栏、设置搜索索引、总览的常用入口和重启恢复校验：页面身份的唯一
// 声明仍是 `types.ts` 的 `SettingsPage`，新增页面必须在这里登记，否则导航与恢复都会丢弃它。
import { SettingsNavGroup, SettingsPage } from './types'


export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    title: '通用',
    items: [
      { page: 'home', title: '总览', desc: '常用入口与需要处理的配置问题' },
      { page: 'appearance', title: '界面', desc: '对话显示密度与显示偏好' },
      { page: 'application', title: '应用与后台', desc: '窗口关闭方式与活动任务控制' },
    ],
  },
  {
    title: '模型与行为',
    items: [
      { page: 'api', title: '模型供应商', desc: 'API 密钥与可用模型' },
      { page: 'agent', title: 'Agent 行为', desc: '通用与编程两套系统提示词，上下文参数在高级设置里' },
    ],
  },
  {
    title: '连接与扩展',
    items: [
      { page: 'web', title: '网络检索', desc: '公开资料、来源与缓存策略' },
      { page: 'browser', title: '内置浏览器', desc: '站点数据、登录状态与缓存管理' },
      { page: 'plugins', title: '插件', desc: '本地插件与工具连接' },
      { page: 'skills', title: '技能', desc: '本地技能、工具说明和可复用能力' },
      { page: 'channels', title: '外部渠道', desc: '通讯渠道连接与重新加载' },
    ],
  },
  {
    title: '存储与环境',
    items: [
      { page: 'storage', title: '存储与数据', desc: '数据位置、迁移与回滚' },
      { page: 'developmentEnvironments', title: '开发环境', desc: 'LS 运行时、工具链和版本偏好' },
    ],
  },
  {
    title: '工作模块',
    items: [
      { page: 'archive', title: '归档', desc: '归档项目和对话管理' },
      { page: 'memoryTree', title: '记忆树', desc: '长期记忆、项目分支和每日召回' },
    ],
  },
  {
    title: '未接入',
    items: [
      // 占位页：不从常用导航出现，但必须能被设置搜索找到，否则用户离开它以后就再也回不去。
      { page: 'scheduled', title: '已安排', desc: '计划任务尚未接入', searchOnly: true },
    ],
  },
]

/** 侧栏与总览显示的条目：`searchOnly` 的占位页不在其中。 */
export function commonSettingsNavGroups(): SettingsNavGroup[] {
  return SETTINGS_NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => item.searchOnly !== true) }))
    .filter((group) => group.items.length > 0)
}

/** 设置搜索的索引：常用导航条目**加上**只应被搜索到的占位页。 */
export function settingsSearchNavGroups(): SettingsNavGroup[] {
  return SETTINGS_NAV_GROUPS.map((group) => ({ ...group, items: [...group.items] }))
}

/** 设置搜索的过滤规则：组名命中保留整组，否则按条目标题与说明过滤。 */
export function filterSettingsNavGroups(
  query: string,
  groups: SettingsNavGroup[] = settingsSearchNavGroups(),
): SettingsNavGroup[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return groups
  return groups
    .map((group) => (group.title.toLocaleLowerCase().includes(normalized)
      ? group
      : {
        ...group,
        items: group.items.filter((item) => (
          `${item.title} ${item.desc}`.toLocaleLowerCase().includes(normalized)
        )),
      }))
    .filter((group) => group.items.length > 0)
}

/** 总览直接列出的常用入口：只放最常用的少数几项，不再复制整份目录。 */
export const SETTINGS_HOME_COMMON_PAGES: SettingsPage[] = ['api', 'appearance', 'web', 'storage']

/** 从设置入口算起，常用设置最多需要的选择次数（含打开设置本身）。 */
export const SETTINGS_REACHABLE_WITHIN_SELECTIONS = 2

export interface SettingsDestination {
  /** 页面身份（`SettingsPage`）：历史存档与新分类共用同一个 id。 */
  page: SettingsPage
  /** 新分类里承载它的分组名。 */
  group: string
  /** 是否出现在侧栏与总览的常用条目里；占位页为 false。 */
  inCommonNavigation: boolean
  /** 是否出现在设置搜索索引里。 */
  searchable: boolean
}

/** 某个页面在新分类里的去向；未登记时返回 null。 */
export function settingsDestination(page: SettingsPage): SettingsDestination | null {
  for (const group of SETTINGS_NAV_GROUPS) {
    const item = group.items.find((candidate) => candidate.page === page)
    if (!item) continue
    return {
      page,
      group: group.title,
      inCommonNavigation: item.searchOnly !== true,
      searchable: true,
    }
  }
  return null
}

/**
 * 旧页面标识 → 新分类的映射。
 *
 * 页面**身份**没有改名，所以持久化路由、返回/前进历史和 `openSettingsPage(id)` 这类深链接
 * 仍按同一个 id 解析；这张表记录每个旧标识现在归到哪一组。`scheduled` 是唯一行为变化的条目：
 * 它从常用导航移到 `searchOnly`（仍可搜索、仍可恢复），因此带 `searchOnly: true`。历史标识若
 * 将来被移除，必须登记进 `REMOVED_SETTINGS_PAGE_IDS` 并给出替代去向，不能静默丢弃。
 */
export interface LegacySettingsPageMapping {
  /** 历史页面标识。 */
  legacyId: SettingsPage
  /** 重命名后的当前标识；没有改名时与 `legacyId` 相同。 */
  resolvedPage: SettingsPage
  /** 新分类里的分组，用于文档与断言。 */
  group: string
  /** 该标识是否已退出常用导航（仍可搜索、仍是合法路由）。 */
  searchOnly: boolean
}

export const LEGACY_SETTINGS_PAGE_GROUPS: LegacySettingsPageMapping[] = [
  { legacyId: 'home', resolvedPage: 'home', group: '通用', searchOnly: false },
  { legacyId: 'application', resolvedPage: 'application', group: '通用', searchOnly: false },
  { legacyId: 'appearance', resolvedPage: 'appearance', group: '通用', searchOnly: false },
  { legacyId: 'agent', resolvedPage: 'agent', group: '模型与行为', searchOnly: false },
  { legacyId: 'api', resolvedPage: 'api', group: '模型与行为', searchOnly: false },
  { legacyId: 'web', resolvedPage: 'web', group: '连接与扩展', searchOnly: false },
  { legacyId: 'storage', resolvedPage: 'storage', group: '存储与环境', searchOnly: false },
  { legacyId: 'browser', resolvedPage: 'browser', group: '连接与扩展', searchOnly: false },
  { legacyId: 'developmentEnvironments', resolvedPage: 'developmentEnvironments', group: '存储与环境', searchOnly: false },
  { legacyId: 'scheduled', resolvedPage: 'scheduled', group: '未接入', searchOnly: true },
  { legacyId: 'memoryTree', resolvedPage: 'memoryTree', group: '工作模块', searchOnly: false },
  { legacyId: 'archive', resolvedPage: 'archive', group: '工作模块', searchOnly: false },
  { legacyId: 'plugins', resolvedPage: 'plugins', group: '连接与扩展', searchOnly: false },
  { legacyId: 'skills', resolvedPage: 'skills', group: '连接与扩展', searchOnly: false },
  { legacyId: 'channels', resolvedPage: 'channels', group: '连接与扩展', searchOnly: false },
]

/** 重命名过的历史标识 → 当前标识。当前为空，保留给后续重排。 */
export const RENAMED_SETTINGS_PAGE_IDS: Readonly<Record<string, SettingsPage>> = {}

/** 已经不再存在的历史标识；为空表示旧标识全部仍然有效。 */
export const REMOVED_SETTINGS_PAGE_IDS: readonly string[] = []

/**
 * 解析一个可能来自历史存档、旧深链接或旧版本的页面标识。
 *
 * 解析顺序：当前标识 → 显式重命名表 → 已移除（回落总览）。因此旧标识要么落到同一个页面，
 * 要么落到一个有明确去向的页面，永远不会变成空白页。
 */
export function resolveSettingsPage(id: string): { page: SettingsPage; legacy: boolean } {
  if (settingsDestination(id as SettingsPage)) return { page: id as SettingsPage, legacy: false }
  const renamed = RENAMED_SETTINGS_PAGE_IDS[id]
  if (renamed && settingsDestination(renamed)) return { page: renamed, legacy: true }
  return { page: 'home', legacy: true }
}
