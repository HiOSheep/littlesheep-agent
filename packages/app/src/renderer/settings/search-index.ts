// S3 字段级搜索：设置表面的字段索引。
//
// 问题（审查发现 #13）：设置搜索只匹配分组名与页面标题/说明，所以“知道字段叫什么、但不知道
// 它在哪一页”的用户仍然找不到它。这份索引把**用户真正能看到、能操作的那一行**变成可寻址对象：
// 每条登记标题、别名、所在分组/页面/小节，以及可以安全发布的当前值。搜索因此能回答“它在哪里”，
// 而不只是“哪一页的描述像”。
//
// 单一来源（不维护第二套目录）：
//   - 页面在自己渲染的行上写 `data-settings-field` 属性（值为字段 id），索引登记同一个 id；二者
//     必须一一对应。
//     `search-index.test.ts` 双向扫描设置页面源码：新增一行不登记、或索引里留着已删除的条目，
//     都会让检查变红。
//   - 每条登记里的标题必须逐字出现在它所属页面的源码里（改名不改索引 = 红），并且至少有一个
//     别名也逐字出现过，避免索引凭空发明措辞。
//   - 下拉选项标签复用页面渲染用的同一份定义（`CLOSE_POLICY_OPTIONS`、`PROFILE_OPTIONS`、
//     `WEB_*_OPTIONS`），所以索引显示的值与用户在该页看到的值是同一个来源。
//
// 值索引的边界（每条恰好给 `readValue` 或 `valueNotIndexed` 之一）：
//   - 只索引“打开页面前就可知、并且发布无害”的值：Runtime 快照与客户端显示偏好。
//   - 密钥值永不进入索引：密钥字段只登记位置和别名，索引里没有任何一条路径能读到它。
//   - 页面加载后才知道的值（数据目录、Cookie 数量、迁移记录）不索引，理由逐条写在 `valueNotIndexed`。
//   - 页面上的未保存草稿不参与搜索：索引读 Runtime，不读表单里正在编辑的那份副本。
//   - 无法逐字段登记的动态区域与工作模块页面记在 `SETTINGS_UNINDEXED_FIELDS`，如实说明而不是
//     假装它们也有字段索引。

import type { RuntimeState } from '../api'
import { readConversationDisplayMode } from '../chat/conversation-display'
import { readAppearancePreferences } from '../app-shell/appearance-preferences'
import { PROFILE_OPTIONS } from '../runtime/options'
import { FOCUSABLE_SELECTOR } from '../ui/modal-layer'
import { CLOSE_POLICY_OPTIONS } from './application-background-state'
import { SETTINGS_NAV_GROUPS, settingsDestination } from './navigation'
import { SettingsPage } from './types'
import {
  WEB_BROWSER_FALLBACK_OPTIONS,
  WEB_DNS_RESOLVER_OPTIONS,
  WEB_READ_MODE_OPTIONS,
  WEB_SENSITIVE_QUERY_OPTIONS,
} from './web-state'

/** 显示器密度偏好的两个显示名；与 `appearance.tsx` 的下拉选项同字，由测试钉住。 */
const CONVERSATION_DISPLAY_LABELS: Record<'normal' | 'compact', string> = {
  normal: '普通',
  compact: '紧凑',
}

const APPEARANCE_THEME_LABELS = { system: '跟随系统', dark: '深色', light: '浅色' } as const
const APPEARANCE_PALETTE_LABELS = { neutral: '中性', ocean: '海蓝', forest: '林绿', custom: '自定义' } as const

/** 行元素上的锚点属性：索引里的 id 与页面渲染的行靠它对应。 */
export const SETTINGS_FIELD_ATTRIBUTE = 'data-settings-field'
/** 落地强调属性：选中结果后短暂出现，用来把眼睛带到那一行。 */
export const SETTINGS_FIELD_LANDED_ATTRIBUTE = 'data-settings-field-landed'
/** 强调持续时长；与样式表里的时长是同一个承诺，测试会比对。 */
export const SETTINGS_FIELD_LANDED_MS = 1_600
/** 落地等待上限：页面渲染 + 展开折叠区 + Runtime 就绪都在这之内完成，超时则如实报告失败。 */
export const SETTINGS_FIELD_LANDING_TIMEOUT_MS = 2_500

export interface SettingsFieldValueContext {
  /** 应用级 Runtime 快照；首次读取完成前为 `null`。 */
  runtime: RuntimeState | null
}

/**
 * 一条可寻址的设置行。
 *
 * `readValue` 与 `valueNotIndexed` 必居其一：要么给出可安全发布的当前值，要么写明为什么不索引。
 * 没有第三种“悄悄不索引”的状态，所以“某个值没被索引”永远能在这份数据里查到原因。
 */
export interface SettingsFieldDefinition {
  /** 稳定 id：同时是页面行上的 `data-settings-field` 值。 */
  readonly id: string
  readonly page: SettingsPage
  /** 行所在的小节标题（页面内的分组，用于说明“在页面的哪一段”）。 */
  readonly section: string
  /** 行标签，必须逐字出现在该页面源码里。 */
  readonly title: string
  /** 用户可能输入、但标签里没有的词。 */
  readonly aliases: readonly string[]
  readonly kind: 'field' | 'action'
  readonly readValue?: (context: SettingsFieldValueContext) => string | null
  readonly valueNotIndexed?: string
  /**
   * 字段只有在某个控件被激活后才存在时，写出那个控件（CSS 选择器）。
   * 落地流程先点它一次，再等字段出现；这是“展开后再定位”，不是第二条导航路径。
   */
  readonly reveal?: string
  /** 该行只在特定条件下渲染（例如没有待处理操作时才显示目录管理）。 */
  readonly conditional?: boolean
}

/** 搜索命中：把“它在哪里”和“它现在是什么”一起交给结果列表。 */
export interface SettingsFieldHit {
  readonly id: string
  readonly page: SettingsPage
  readonly group: string
  readonly pageTitle: string
  readonly section: string
  readonly title: string
  readonly kind: 'field' | 'action'
  readonly value: string | null
  readonly valueNotIndexed: string | null
  readonly reveal: string | null
  /** 结果行显示的位置串：`分组 › 页面 › 设置项`。 */
  readonly path: string
}

/** 有意不做字段级索引的区域：记下来，而不是索引一个会误导人的东西。 */
export interface SettingsUnindexedField {
  readonly what: string
  readonly where: string
  readonly why: string
}

function labelledById<T extends string>(
  options: readonly { id: T; label: string }[],
  id: T | undefined,
): string | null {
  if (id === undefined) return null
  return options.find((option) => option.id === id)?.label ?? null
}

function labelledByValue<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T | undefined,
): string | null {
  if (value === undefined) return null
  return options.find((option) => option.value === value)?.label ?? null
}

export const SETTINGS_FIELD_INDEX: readonly SettingsFieldDefinition[] = [
  // ---- 通用 › 界面 ------------------------------------------------------------------------
  {
    id: 'appearance.conversation-display',
    page: 'appearance',
    section: '对话显示',
    title: '对话显示密度',
    aliases: ['对话显示', '显示密度', '对话显示模式', '过程内容', '紧凑', '普通'],
    kind: 'field',
    readValue: () => CONVERSATION_DISPLAY_LABELS[readConversationDisplayMode()],
  },
  {
    id: 'appearance.interface-font-size',
    page: 'appearance',
    section: '文字大小',
    title: '界面字号',
    aliases: ['界面字号', '界面字体大小', '文字大小', '字号'],
    kind: 'field',
    readValue: () => `${readAppearancePreferences().interfaceFontSize}px`,
  },
  {
    id: 'appearance.chat-font-size',
    page: 'appearance',
    section: '文字大小',
    title: '聊天字号',
    aliases: ['聊天字号', '聊天正文字号', '聊天字体大小', '消息字体'],
    kind: 'field',
    readValue: () => `${readAppearancePreferences().chatFontSize}px`,
  },
  {
    id: 'appearance.theme-mode',
    page: 'appearance',
    section: '主题',
    title: '明暗模式',
    aliases: ['明暗模式', '主题模式', '浅色', '深色', '跟随系统'],
    kind: 'field',
    readValue: () => APPEARANCE_THEME_LABELS[readAppearancePreferences().theme],
  },
  {
    id: 'appearance.palette',
    page: 'appearance',
    section: '主题',
    title: '配色',
    aliases: ['主题配色', '配色预设', '自定义颜色'],
    kind: 'field',
    readValue: () => APPEARANCE_PALETTE_LABELS[readAppearancePreferences().palette],
  },
  {
    id: 'appearance.color-accent',
    page: 'appearance',
    section: '自定义配色',
    title: '强调色',
    aliases: ['强调色', '强调颜色', '焦点颜色', '图表颜色'],
    kind: 'field',
    readValue: () => readAppearancePreferences().colors.accent,
    reveal: 'button.appearance-custom-open',
  },
  {
    id: 'appearance.color-background',
    page: 'appearance',
    section: '自定义配色',
    title: '背景色',
    aliases: ['背景色', '主背景色', '窗口背景', '底色'],
    kind: 'field',
    readValue: () => readAppearancePreferences().colors.background,
    reveal: 'button.appearance-custom-open',
  },
  {
    id: 'appearance.color-surface',
    page: 'appearance',
    section: '自定义配色',
    title: '面板色调',
    aliases: ['面板色调', '面板颜色', '玻璃表面颜色', '浮层颜色'],
    kind: 'field',
    readValue: () => readAppearancePreferences().colors.surface,
    reveal: 'button.appearance-custom-open',
  },
  {
    id: 'appearance.code-font-size',
    page: 'appearance',
    section: '高级文字设置',
    title: '代码字号',
    aliases: ['代码字号', '代码字体大小', '编辑器字号', 'Monaco 字体'],
    kind: 'field',
    readValue: () => `${readAppearancePreferences().codeFontSize}px`,
    reveal: 'details.appearance-advanced > summary',
  },
  {
    id: 'appearance.terminal-font-size',
    page: 'appearance',
    section: '高级文字设置',
    title: '终端字号',
    aliases: ['终端字号', '终端字体大小', '控制台字号'],
    kind: 'field',
    readValue: () => `${readAppearancePreferences().terminalFontSize}px`,
    reveal: 'details.appearance-advanced > summary',
  },

  // ---- 通用 › 应用与后台 ------------------------------------------------------------------
  {
    id: 'application.close-policy',
    page: 'application',
    section: '关闭窗口时',
    title: '窗口关闭方式',
    aliases: ['关闭窗口', '关闭行为', '后台', '托盘'],
    kind: 'field',
    readValue: ({ runtime }) => labelledById(CLOSE_POLICY_OPTIONS, runtime?.closePolicy),
  },

  // ---- 模型与行为 › Agent 行为 ------------------------------------------------------------
  {
    id: 'agent.profile',
    page: 'agent',
    section: '行为配置',
    title: 'Agent 行为',
    aliases: ['Agent 行为配置', '行为配置', '系统提示词', 'profile'],
    kind: 'field',
    readValue: ({ runtime }) => labelledById(PROFILE_OPTIONS, runtime?.profile),
  },
  {
    id: 'agent.compression-threshold',
    page: 'agent',
    section: '上下文',
    title: '压缩触发阈值',
    aliases: ['压缩阈值', '阈值', '上下文压缩', '摘要', '高级上下文设置'],
    kind: 'field',
    readValue: ({ runtime }) => (
      runtime ? `${Math.round(runtime.contextCompressionThresholdRatio * 100)}%` : null
    ),
    // 折叠在 <details> 里：不先展开，这一行既不可见也不可聚焦。
    reveal: 'details.settings-advanced > summary',
  },

  // ---- 连接与扩展 › 网络检索 --------------------------------------------------------------
  {
    id: 'web.enabled',
    page: 'web',
    section: '网络检索状态',
    title: '实时资料',
    aliases: ['启用网络检索', '网络检索开关', '外发', '网络开关'],
    kind: 'field',
    readValue: ({ runtime }) => (runtime ? (runtime.web.enabled ? '已启用' : '已关闭') : null),
  },
  {
    id: 'web.provider-key',
    page: 'web',
    section: '搜索服务配置',
    title: 'Tavily API key',
    aliases: ['API Key', '密钥', 'Tavily', '搜索服务', '搜索服务密钥'],
    kind: 'field',
    // 机密：只登记位置。索引里没有读取它的路径，结果里也不会出现它的任何字符。
    valueNotIndexed: '密钥值属机密，永不进入索引或结果文本；索引只记住这个字段在哪里。',
  },
  {
    id: 'web.read-mode',
    page: 'web',
    section: '读取策略',
    title: '公开读取模式',
    // 具体的模式名（“公开匿名读取”等）是有意留给“当前值”的：用户输入「匿名」时靠值命中，
    // 而不是靠别名，所以这些选项名不进别名表。
    aliases: ['读取模式', '公开读取', '允许域名'],
    kind: 'field',
    readValue: ({ runtime }) => labelledByValue(WEB_READ_MODE_OPTIONS, runtime?.web.readMode),
  },
  {
    id: 'web.dns-resolver',
    page: 'web',
    section: '读取策略',
    title: '域名解析',
    aliases: ['DNS', '解析', 'Cloudflare'],
    kind: 'field',
    readValue: ({ runtime }) => labelledByValue(WEB_DNS_RESOLVER_OPTIONS, runtime?.web.dnsResolver),
  },
  {
    id: 'web.strict-read-approval',
    page: 'web',
    section: '读取策略',
    title: '严格读取审批',
    aliases: ['审批', '逐次确认', 'safe read'],
    kind: 'field',
    readValue: ({ runtime }) => (runtime ? (runtime.web.strictReadApproval ? '已开启' : '已关闭') : null),
  },
  {
    id: 'web.sensitive-query-policy',
    page: 'web',
    section: '读取策略',
    title: '敏感查询',
    aliases: ['敏感', '查询策略', '外发'],
    kind: 'field',
    readValue: ({ runtime }) => labelledByValue(WEB_SENSITIVE_QUERY_OPTIONS, runtime?.web.sensitiveQueryPolicy),
  },
  {
    id: 'web.browser-fallback',
    page: 'web',
    section: '读取策略',
    title: '浏览器后备',
    aliases: ['后备', '需要批准', '仅完全访问'],
    kind: 'field',
    readValue: ({ runtime }) => labelledByValue(WEB_BROWSER_FALLBACK_OPTIONS, runtime?.web.browserFallback),
  },
  {
    id: 'web.cache-enabled',
    page: 'web',
    section: '网络资料缓存',
    title: '资料缓存',
    aliases: ['缓存', '保留时间', '缓存时长'],
    kind: 'field',
    readValue: ({ runtime }) => (
      runtime
        ? (runtime.web.cacheEnabled ? `${runtime.web.cacheTtlSeconds} 秒保留` : '已关闭')
        : null
    ),
  },
  {
    id: 'web.cache-clear',
    page: 'web',
    section: '网络资料缓存',
    title: '清理网络缓存',
    aliases: ['清除缓存', '清空缓存', '网络缓存'],
    kind: 'action',
    valueNotIndexed: '动作没有“当前值”，索引只记住它的位置。',
  },

  // ---- 存储与环境 › 存储与数据 ------------------------------------------------------------
  {
    id: 'storage.current-data-dir',
    page: 'storage',
    section: '当前状态',
    title: '当前数据目录',
    aliases: ['数据目录', '数据根', '目录位置', 'data dir'],
    kind: 'field',
    valueNotIndexed: '目录路径来自页面加载后的 Runtime 状态，打开页面前不可知；路径不写入索引。',
  },
  {
    id: 'storage.migrate',
    page: 'storage',
    section: '目录管理',
    title: '迁移完整数据根',
    aliases: ['迁移', '换目录', '移动数据', '选择新位置'],
    kind: 'action',
    valueNotIndexed: '动作没有“当前值”；且这一行只在没有待处理操作时渲染。',
    conditional: true,
  },
  {
    id: 'storage.rollback',
    page: 'storage',
    section: '目录管理',
    title: '回滚到前一个目录',
    aliases: ['回滚', '撤销迁移', '登记回滚'],
    kind: 'action',
    valueNotIndexed: '动作没有“当前值”；只有存在可回滚目录时才渲染。',
    conditional: true,
  },
  {
    id: 'storage.last-migration',
    page: 'storage',
    section: '最近迁移',
    title: '最近迁移',
    aliases: ['迁移记录', '上次迁移', '文件数量'],
    kind: 'field',
    valueNotIndexed: '内容来自最近一次迁移结果，页面加载后才知道，因此不写入索引。',
    conditional: true,
  },

  // ---- 连接与扩展 › 内置浏览器 ------------------------------------------------------------
  {
    id: 'browser.partition',
    page: 'browser',
    section: '当前状态',
    title: '浏览器分区',
    aliases: ['分区', '站点数据空间', '持久化'],
    kind: 'field',
    valueNotIndexed: '分区名来自浏览器状态接口，打开页面前不可知。',
  },
  {
    id: 'browser.cookie-count',
    page: 'browser',
    section: '当前状态',
    title: '已保存 Cookie',
    aliases: ['Cookie', '登录状态', '网站登录', 'Cookie 数量'],
    kind: 'field',
    // 这一行本身就只显示数量：站点名和值从不展示。索引沿用同一个边界。
    valueNotIndexed: '只显示数量；具体站点与 Cookie 值从不展示，也不进入索引。',
  },
  {
    id: 'browser.clear-cache',
    page: 'browser',
    section: '数据管理',
    title: '清除网页缓存',
    aliases: ['清缓存', '网页缓存', '清除缓存'],
    kind: 'action',
    valueNotIndexed: '动作没有“当前值”，索引只记住它的位置。',
  },
  {
    id: 'browser.clear-data',
    page: 'browser',
    section: '数据管理',
    title: '清除所有网站数据',
    aliases: ['清空网站数据', '退出网站登录', '删除 Cookie'],
    kind: 'action',
    valueNotIndexed: '动作没有“当前值”，索引只记住它的位置。',
  },

  // ---- 连接与扩展 › 插件 ------------------------------------------------------------------
  {
    id: 'plugins.trust-local-code',
    page: 'plugins',
    section: '本地插件信任',
    title: '本地插件代码',
    aliases: ['本地插件', '信任插件', '允许执行本地插件代码', '插件代码'],
    kind: 'field',
    valueNotIndexed: '开关状态来自插件状态接口，打开页面前不可知。',
  },

  // ---- 模型与行为 › 模型供应商（嵌套编辑器里的密钥字段） ----------------------------------
  {
    id: 'api.provider-key',
    page: 'api',
    section: '供应商编辑器',
    title: 'API 密钥',
    aliases: ['API Key', 'api key', '密钥', '鉴权'],
    kind: 'field',
    valueNotIndexed: '密钥值属机密，永不进入索引或结果文本；索引只记住它在编辑器里的位置。',
    // 编辑器默认不开：落地时先点某个供应商卡片上的“编辑”，再定位密钥输入框。
    reveal: '.provider-card .save-btn',
    conditional: true,
  },
]

/**
 * 有意不做字段级索引的区域。
 *
 * 这里不是“待办清单”，而是边界声明：这些位置要么随运行状态/本机环境变化，要么所有权不在设置
 * 搜索手里，要么属于机密。搜索仍能带用户到它们所在的页面，但不能声称能定位到某一行。
 */
export const SETTINGS_UNINDEXED_FIELDS: readonly SettingsUnindexedField[] = [
  {
    what: '供应商编辑器里的其它输入（供应商 ID、显示名称、API 地址、模型行）',
    where: '模型供应商',
    why: '只在某个供应商的编辑器打开后存在，值是未保存的草稿；索引不保存草稿，也不为每种供应商身份登记一份字段。密钥字段是唯一例外：它按标签登记位置，值永不索引。',
  },
  {
    what: '数据目录路径、浏览器分区名、Cookie 数量、最近迁移记录',
    where: '存储与数据 / 内置浏览器',
    why: '值来自页面加载后的 Runtime 或浏览器状态，打开页面前不可知，因此不写入索引。',
  },
  {
    what: '开发环境每行的目标版本、导入与移除动作、已安装版本列表',
    where: '开发环境',
    why: '行随本机检测到的运行时与工具链变化，数量、身份和版本号都不固定。',
  },
  {
    what: '插件列表里每个插件自己的开关、来源与错误状态',
    where: '插件',
    why: '行随已安装插件变化；索引只登记页面上位置稳定的“本地插件代码”信任开关。',
  },
  {
    what: '活动任务列表里的单个任务与其暂停/中断控件',
    where: '应用与后台',
    why: '那是 Runtime 运行状态而不是设置字段，随任务出现和消失。',
  },
  {
    what: '归档、技能、外部渠道、记忆树的页面内部字段',
    where: '工作模块',
    why: '这些页面由工作模块组件渲染，字段所有权不在设置搜索索引里；搜索仍能按页面名到达。',
  },
  {
    what: '任何密钥的“值”（供应商 API 密钥、Tavily 密钥、Cookie 值）',
    where: '模型供应商 / 网络检索 / 内置浏览器',
    why: '机密值永不进入索引、结果文本或索引测试夹具；索引只登记字段位置、标签与别名。',
  },
  {
    what: '页面上正在编辑、尚未保存的草稿值',
    where: '全部设置页',
    why: '索引读的是 Runtime 快照，不读表单副本；草稿值不参与搜索，避免把“还没保存的东西”当成现状。',
  },
]

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function navigationItem(page: SettingsPage): { group: string; pageTitle: string; order: number } | null {
  let order = 0
  for (const group of SETTINGS_NAV_GROUPS) {
    for (const item of group.items) {
      if (item.page === page) return { group: group.title, pageTitle: item.title, order }
      order += 1
    }
  }
  return null
}

/**
 * 一条登记相对一个查询的得分。0 表示不命中。
 *
 * 顺序即优先级：标签精确 > 标签前缀 > 标签包含 > 别名 > 小节 > 页面/分组 > **值**。
 * 值排最后是有意的：用户输入“匿名”时，字段标签不是它要找的东西，值才是。
 */
function matchScore(
  query: string,
  definition: SettingsFieldDefinition,
  pageTitle: string,
  group: string,
  value: string | null,
): number {
  const title = normalized(definition.title)
  if (title === query) return 120
  if (title.startsWith(query)) return 100
  if (title.includes(query)) return 80
  if (definition.aliases.some((alias) => normalized(alias).includes(query))) return 60
  if (normalized(definition.section).includes(query)) return 40
  if (normalized(pageTitle).includes(query) || normalized(group).includes(query)) return 20
  if (value !== null && normalized(value).includes(query)) return 10
  return 0
}

/** 读取一条登记的当前值；没有读取器时返回 `null`。 */
export function settingsFieldValue(
  definition: SettingsFieldDefinition,
  context: SettingsFieldValueContext,
): string | null {
  if (!definition.readValue) return null
  const value = definition.readValue(context)
  return value && value.trim() ? value : null
}

/** 按查询返回字段级命中，按得分、页面顺序、标签排序，结果是确定的。 */
export function searchSettingsFields(
  query: string,
  context: SettingsFieldValueContext = { runtime: null },
  definitions: readonly SettingsFieldDefinition[] = SETTINGS_FIELD_INDEX,
): SettingsFieldHit[] {
  const needle = normalized(query)
  if (!needle) return []
  const scored: Array<{ hit: SettingsFieldHit; score: number; order: number }> = []
  for (const definition of definitions) {
    const destination = settingsDestination(definition.page)
    if (!destination) continue
    const navigation = navigationItem(definition.page)
    if (!navigation) continue
    const value = settingsFieldValue(definition, context)
    const score = matchScore(needle, definition, navigation.pageTitle, navigation.group, value)
    if (score === 0) continue
    scored.push({
      score,
      order: navigation.order,
      hit: {
        id: definition.id,
        page: definition.page,
        group: navigation.group,
        pageTitle: navigation.pageTitle,
        section: definition.section,
        title: definition.title,
        kind: definition.kind,
        value,
        valueNotIndexed: definition.valueNotIndexed ?? null,
        reveal: definition.reveal ?? null,
        path: `${navigation.group} › ${navigation.pageTitle} › ${definition.title}`,
      },
    })
  }
  return scored
    .sort((left, right) => (
      right.score - left.score
      || left.order - right.order
      || left.hit.title.localeCompare(right.hit.title, 'zh-Hans-CN')
    ))
    .map((entry) => entry.hit)
}

/** 一条登记；找不到时返回 `null`（例如旧结果引用了已被删掉的字段）。 */
export function settingsFieldDefinition(id: string): SettingsFieldDefinition | null {
  return SETTINGS_FIELD_INDEX.find((definition) => definition.id === id) ?? null
}

/** 页面上那一行的选择器。 */
export function settingsFieldSelector(id: string): string {
  return `[${SETTINGS_FIELD_ATTRIBUTE}="${id}"]`
}

/** 结果列表的 DOM id：搜索框用 `aria-controls` 指向它。 */
export const SETTINGS_FIELD_LISTBOX_ID = 'settings-field-results'

/** 结果选项的 DOM id：`aria-activedescendant` 指向它，因此必须由命中位置唯一决定。 */
export function settingsFieldOptionId(index: number): string {
  return `settings-field-option-${index}`
}

/** 搜索框上的一个按键对结果环的作用；`none` 表示这个键不归搜索管。 */
export type SettingsSearchKeyIntent = 'next' | 'previous' | 'take' | 'none'

/**
 * 键盘约定本身（不是它的接线）：↑↓ 移动结果环，Enter 只在环已经落在某条结果上时取用它，
 * Escape 不在这里处理——它归 `ui/modal-surface.ts` 的作用域所有者，好让“Escape 只作用于最上层”
 * 这条规则只有一个实现。这里返回的是**决定**，组件负责执行，测试因此可以逐条断言。
 */
export function settingsSearchKeyIntent(key: string, hasActiveHit: boolean): SettingsSearchKeyIntent {
  if (key === 'ArrowDown') return 'next'
  if (key === 'ArrowUp') return 'previous'
  if (key === 'Enter' && hasActiveHit) return 'take'
  return 'none'
}

/**
 * 结果环的下一个位置。
 *
 * 第一下从输入框落进第一条（`current` 为 -1），到底回卷，↑ 从输入框直接到最后一条；
 * 没有结果时返回 -1，表示不存在环（此时 ↑↓ 不应该被吞掉）。
 */
export function nextSettingsFieldIndex(
  current: number,
  count: number,
  intent: Extract<SettingsSearchKeyIntent, 'next' | 'previous'>,
): number {
  if (count <= 0) return -1
  const direction = intent === 'next' ? 1 : -1
  const base = current < 0 ? (direction === 1 ? -1 : 0) : current
  return (base + direction + count) % count
}

export interface SettingsFieldLanding {
  readonly id: string
  /** 为了看见这一行而展开的容器（目前只有折叠的 `<details>`）。 */
  readonly revealed: readonly string[]
  /** 光标落在哪里：字段自己的控件、行本身、或没能落下。 */
  readonly focus: 'control' | 'row' | 'none'
}

/**
 * 把一行设置变成用户能看见、能继续操作的位置。
 *
 * 这里**不拥有焦点**：焦点生命周期归 `ui/focus-ownership.ts`（进入/离开表面的规则），本函数只
 * 处理“元素存在之后把它带进视野并落下光标”，并返回它实际做了什么。折叠的 `<details>` 会先被
 * 展开——这是让字段可见的必要动作，不是第二条导航路径。
 */
export function revealSettingsField(id: string, doc: Document = document): SettingsFieldLanding | null {
  const anchor = doc.querySelector<HTMLElement>(settingsFieldSelector(id))
  if (!anchor) return null
  const revealed: string[] = []
  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open) {
      parent.open = true
      revealed.push('details')
    }
  }
  anchor.scrollIntoView({ block: 'center', inline: 'nearest' })
  let focus: SettingsFieldLanding['focus'] = 'none'
  const control = anchor.matches(FOCUSABLE_SELECTOR)
    ? anchor
    : anchor.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
  if (control) {
    control.focus({ preventScroll: true })
    if (doc.activeElement === control) focus = 'control'
  }
  if (focus === 'none') {
    // 没有可聚焦控件的行（动作行、只读行）也能被键盘读到：行自己接受焦点。
    anchor.tabIndex = -1
    anchor.focus({ preventScroll: true })
    if (doc.activeElement === anchor) focus = 'row'
  }
  anchor.setAttribute(SETTINGS_FIELD_LANDED_ATTRIBUTE, 'true')
  doc.defaultView?.setTimeout(() => {
    anchor.removeAttribute(SETTINGS_FIELD_LANDED_ATTRIBUTE)
  }, SETTINGS_FIELD_LANDED_MS)
  return { id, revealed, focus }
}
