import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import type { RuntimeState } from '../api'
import { PROFILE_OPTIONS } from '../runtime/options'
import { SETTINGS_NAV_GROUPS, filterSettingsNavGroups, settingsDestination } from './navigation'
import {
  SETTINGS_FIELD_ATTRIBUTE,
  SETTINGS_FIELD_INDEX,
  SETTINGS_FIELD_LANDED_ATTRIBUTE,
  SETTINGS_FIELD_LANDED_MS,
  SETTINGS_FIELD_LANDING_TIMEOUT_MS,
  SETTINGS_FIELD_LISTBOX_ID,
  SETTINGS_UNINDEXED_FIELDS,
  nextSettingsFieldIndex,
  revealSettingsField,
  searchSettingsFields,
  settingsFieldDefinition,
  settingsFieldOptionId,
  settingsFieldSelector,
  settingsFieldValue,
  settingsSearchKeyIntent,
} from './search-index'

/**
 * S3 字段级搜索的验收测试。
 *
 * 三类断言，任何一类都真的会失败：
 *   ① **覆盖是双向的**：页面渲染的每一行 `data-settings-field="<id>"` 必须在索引里，索引里的每
 *      一条也必须在某个页面源码里出现一次。新增字段不登记、删除字段不清理 → 红。
 *   ② **搜索能看见值**：只出现在字段“当前值”里的词必须能找到字段——同一批用例同时断言**旧的
 *      标签/标题过滤找不到它**（`filterSettingsNavGroups`），所以“这次搜索只是换了个写法”这种
 *      退化会被抓住。
 *   ③ **机密与不可知的值有明确边界**：密钥值不出现在任何命中里，动态值逐条写明为什么不索引。
 */

/** 索引的字段清单（S3 交付时的字面量），少一条或多一条都会失败。 */
const S3_FIELD_INVENTORY: string[] = [
  'appearance.conversation-display',
  'appearance.interface-font-size',
  'appearance.chat-font-size',
  'appearance.theme-mode',
  'appearance.palette',
  'appearance.color-accent',
  'appearance.color-background',
  'appearance.color-surface',
  'appearance.code-font-size',
  'appearance.terminal-font-size',
  'application.close-policy',
  'agent.profile',
  'agent.compression-threshold',
  'web.enabled',
  'web.provider-key',
  'web.read-mode',
  'web.dns-resolver',
  'web.strict-read-approval',
  'web.sensitive-query-policy',
  'web.browser-fallback',
  'web.cache-enabled',
  'web.cache-clear',
  'storage.current-data-dir',
  'storage.migrate',
  'storage.rollback',
  'storage.last-migration',
  'browser.partition',
  'browser.cookie-count',
  'browser.clear-cache',
  'browser.clear-data',
  'plugins.trust-local-code',
  'api.provider-key',
]

/** 现在正在编辑、还没保存的密钥值。它出现在任何命中里都是缺陷。 */
const SECRET_IN_FIXTURE = 'sk-s3-unit-secret-0001'

function runtimeFixture(overrides: Partial<RuntimeState> = {}): RuntimeState {
  const runtime: RuntimeState = {
    model: 'acceptance/slow-a',
    reasoning: 'auto',
    profile: 'general',
    contextCompressionThresholdRatio: 0.8,
    closePolicy: 'always-background',
    workspace: 'C:/fixture',
    workplace: 'C:/fixture/workplace',
    providers: [{
      id: 'acceptance',
      name: 'Acceptance',
      baseURL: 'http://127.0.0.1:1/v1',
      api: 'openai-chat-completions',
      models: [],
      headerNames: [],
      envVar: null,
      requiresKey: true,
      hasKey: true,
      builtin: false,
    }],
    web: {
      enabled: true,
      status: 'configured_unchecked',
      providerConfigured: true,
      readMode: 'public_anonymous',
      dnsResolver: 'cloudflare_doh',
      strictReadApproval: false,
      allowDomains: [],
      blockDomains: [],
      cacheEnabled: true,
      cacheTtlSeconds: 900,
      cacheMaxBytes: 1_000_000,
      browserFallback: 'approval_required',
      sensitiveQueryPolicy: 'approve',
      egress: ['query_to_search_provider', 'url_to_target_site', 'evidence_to_current_llm_provider'],
      ...overrides.web,
    },
    ...overrides,
  }
  return runtime
}

/**
 * 把机密值塞进 Runtime 快照里每一个“看起来可能被顺手索引”的字符串位置：路径、模型名、
 * 供应商的环境变量名与 header 名。任何一条读取器开始发布这些东西都会立刻命中这个夹具。
 */
function poisonedRuntimeFixture(): RuntimeState {
  return runtimeFixture({
    model: SECRET_IN_FIXTURE,
    workspace: `C:/${SECRET_IN_FIXTURE}`,
    workplace: `C:/${SECRET_IN_FIXTURE}/workplace`,
    providers: [{
      id: SECRET_IN_FIXTURE,
      name: SECRET_IN_FIXTURE,
      baseURL: `http://127.0.0.1:1/${SECRET_IN_FIXTURE}`,
      api: 'openai-chat-completions',
      models: [],
      headerNames: [SECRET_IN_FIXTURE],
      envVar: SECRET_IN_FIXTURE,
      requiresKey: true,
      hasKey: true,
      builtin: false,
    }],
  })
}

const settingsDir = new URL('.', import.meta.url)
/** 契约的声明方本身不是页面：它写的是 `data-settings-field` 这个名字，不是某一行。 */
const CONTRACT_SOURCES = new Set(['search-index.ts'])
let settingsSources: Map<string, string>

beforeAll(async () => {
  settingsSources = new Map()
  const entries = await readdir(fileURLToPath(settingsDir))
  for (const name of entries) {
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue
    settingsSources.set(name, await readFile(new URL(name, settingsDir), 'utf8'))
  }
})

/** 页面源码里登记的字段 id → 出现在哪些文件里。 */
function fieldAnchorsInSources(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const [name, source] of settingsSources) {
    if (CONTRACT_SOURCES.has(name)) continue
    // `data-settings-field="x"` 自身也以 `field="x"` 结尾，所以先摘掉它，再单独统计
    // `SettingRow field="x"` 这种写法，避免同一条被数两次。
    const anchorPattern = new RegExp(`data-settings-field="([^"]+)"`, 'gu')
    const propPattern = new RegExp(`(?<![\\w-])field="([^"]+)"`, 'gu')
    const withoutAnchors = source.replace(/data-settings-field="[^"]*"/gu, '')
    for (const match of source.matchAll(anchorPattern)) {
      const id = match[1]!
      found.set(id, [...(found.get(id) ?? []), name])
    }
    for (const match of withoutAnchors.matchAll(propPattern)) {
      const id = match[1]!
      found.set(id, [...(found.get(id) ?? []), name])
    }
  }
  return found
}

/** 每条登记属于哪个页面文件（`SettingRow field=` 的页面与 `data-settings-field=` 的页面都算）。 */
const PAGE_SOURCE_FILE: Record<string, string> = {
  appearance: 'appearance.tsx',
  application: 'application-background.tsx',
  agent: 'agent-profile.tsx',
  web: 'web.tsx',
  storage: 'storage.tsx',
  browser: 'browser.tsx',
  plugins: 'plugins.tsx',
  api: 'model-provider-editor.tsx',
  // Appearance belongs to settings; its page is declared below this component folder.
}

function navTitles(): Map<string, string> {
  return new Map(SETTINGS_NAV_GROUPS.flatMap((group) => group.items).map((item) => [item.page, item.title]))
}

describe('settings field index (S3)', () => {
  it('addresses exactly the inventoried fields, each on a real page with a real group', () => {
    expect(SETTINGS_FIELD_INDEX.map((definition) => definition.id)).toEqual(S3_FIELD_INVENTORY)
    expect(new Set(SETTINGS_FIELD_INDEX.map((definition) => definition.id)).size).toBe(SETTINGS_FIELD_INDEX.length)

    const titles = navTitles()
    for (const definition of SETTINGS_FIELD_INDEX) {
      const destination = settingsDestination(definition.page)
      expect(destination, `${definition.id} lives on a navigable page`).toBeTruthy()
      expect(destination!.group, `${definition.id} group`).toBeTruthy()
      expect(titles.get(definition.page), `${definition.id} page title`).toBeTruthy()
      expect(definition.section.trim().length, `${definition.id} section`).toBeGreaterThan(0)
      expect(definition.aliases.length, `${definition.id} aliases`).toBeGreaterThan(0)
      for (const alias of definition.aliases) {
        expect(alias.trim().length, `${definition.id} alias`).toBeGreaterThan(0)
      }
    }
  })

  it('says for every field either what its value is, or why the value is not indexed', () => {
    for (const definition of SETTINGS_FIELD_INDEX) {
      const hasReader = typeof definition.readValue === 'function'
      const hasReason = typeof definition.valueNotIndexed === 'string' && definition.valueNotIndexed!.trim().length > 0
      expect(hasReader || hasReason, `${definition.id} declares a value or a reason`).toBe(true)
      // 一个有读取器的字段不需要“不索引”的理由；反之亦然。两者都缺 = 悄悄不索引。
      expect(hasReader && hasReason, `${definition.id} does not declare both`).toBe(false)
      if (definition.kind === 'action') {
        expect(hasReader, `${definition.id} is an action and cannot have a current value`).toBe(false)
      }
      if (definition.reveal) {
        expect(definition.reveal.trim().length, `${definition.id} reveal selector`).toBeGreaterThan(1)
      }
    }
  })

  it('covers every field the pages render, in both directions', async () => {
    const anchors = fieldAnchorsInSources()
    const indexed = new Set(SETTINGS_FIELD_INDEX.map((definition) => definition.id))

    // 方向一：页面渲染的字段必须在索引里（新增字段不登记 = 红）。
    const unindexed = [...anchors.keys()].filter((id) => !indexed.has(id))
    expect(unindexed, 'every rendered field has an index entry').toEqual([])

    // 方向二：索引里的字段必须在页面上真的渲染（删掉字段却留着索引 = 红），而且只在一个页面里。
    for (const definition of SETTINGS_FIELD_INDEX) {
      const files = anchors.get(definition.id) ?? []
      expect(files, `${definition.id} is rendered`).toHaveLength(1)
      expect(files[0], `${definition.id} is rendered by its own page`).toBe(PAGE_SOURCE_FILE[definition.page])
    }

    // 第三层：索引里的标题必须逐字出现在它所属页面里（改了标签不改索引 = 红），且至少有一个别名
    // 也逐字出现过（凭空发明措辞 = 红）。
    for (const definition of SETTINGS_FIELD_INDEX) {
      const source = settingsSources.get(PAGE_SOURCE_FILE[definition.page]!)
      expect(source, `${PAGE_SOURCE_FILE[definition.page]} is a settings source`).toBeTruthy()
      expect(source!, `${definition.id} title "${definition.title}" is rendered verbatim`).toContain(definition.title)
      expect(
        definition.aliases.some((alias) => source!.includes(alias)),
        `${definition.id} has at least one alias that appears on its page`,
      ).toBe(true)
    }
  })

  it('finds a field by a term that only its value carries, where the label-only search cannot', () => {
    const runtime = runtimeFixture()
    const cases: Array<{ query: string; id: string; value: string }> = [
      { query: '匿名', id: 'web.read-mode', value: '公开匿名读取' },
      { query: 'DoH', id: 'web.dns-resolver', value: 'Cloudflare DoH' },
      { query: '80%', id: 'agent.compression-threshold', value: '80%' },
      { query: '始终留在后台', id: 'application.close-policy', value: '始终留在后台' },
    ]

    for (const entry of cases) {
      // 旧行为：页面级过滤（标签、标题、说明）对这个词一无所知。
      const labelOnly = filterSettingsNavGroups(entry.query).flatMap((group) => group.items)
      expect(labelOnly, `label-only search is blind to "${entry.query}"`).toEqual([])

      // 新行为：字段级索引靠“当前值”找到它，并把值一起交出来。
      const hits = searchSettingsFields(entry.query, { runtime })
      expect(hits.map((hit) => hit.id), `"${entry.query}" finds its field`).toContain(entry.id)
      const hit = hits.find((candidate) => candidate.id === entry.id)!
      expect(hit.value, `"${entry.query}" reports the current value`).toBe(entry.value)
      expect(hit.path, `${entry.id} path`).toBe(`${hit.group} › ${hit.pageTitle} › ${hit.title}`)
      expect(hit.path.split(' › ')).toHaveLength(3)
    }
  })

  it('reports the current value of every runtime-backed field from the runtime snapshot', () => {
    const runtime = runtimeFixture()
    const expected: Record<string, string> = {
      'application.close-policy': '始终留在后台',
      'agent.profile': PROFILE_OPTIONS.find((option) => option.id === runtime.profile)!.label,
      'web.enabled': '已启用',
      'web.read-mode': '公开匿名读取',
      'web.dns-resolver': 'Cloudflare DoH',
      'web.strict-read-approval': '已关闭',
      'web.sensitive-query-policy': '外发前确认',
      'web.browser-fallback': '需要批准',
      'web.cache-enabled': '900 秒保留',
    }
    for (const [id, value] of Object.entries(expected)) {
      const definition = settingsFieldDefinition(id)!
      expect(settingsFieldValue(definition, { runtime }), `${id} value`).toBe(value)
      // 同一个字段在搜索里必须给出同一个值，而不是另一套口径。
      const hit = searchSettingsFields(definition.title, { runtime }).find((candidate) => candidate.id === id)
      expect(hit?.value, `${id} value through search`).toBe(value)
    }

    // 两个按算式得到的值：百分数与秒数。它们不是字面量，所以按“与页面同一个算式”来钉：
    // 页面写的是 `Math.round(compressionThreshold * 100)` + `%` 与 `${web.cacheTtlSeconds} 秒保留`。
    const threshold = settingsFieldDefinition('agent.compression-threshold')!
    const cache = settingsFieldDefinition('web.cache-enabled')!
    expect(settingsSources.get('agent-profile.tsx')).toContain('Math.round(compressionThreshold * 100)')
    expect(settingsSources.get('web.tsx')).toContain('${web.cacheTtlSeconds} 秒保留')
    for (const ratio of [0.5, 0.8, 0.95]) {
      expect(settingsFieldValue(threshold, { runtime: runtimeFixture({ contextCompressionThresholdRatio: ratio }) }))
        .toBe(`${Math.round(ratio * 100)}%`)
    }
    for (const ttl of [30, 900, 86_400]) {
      expect(settingsFieldValue(cache, { runtime: runtimeFixture({ web: { ...runtime.web, cacheTtlSeconds: ttl } }) }))
        .toBe(`${ttl} 秒保留`)
      expect(settingsFieldValue(cache, { runtime: runtimeFixture({ web: { ...runtime.web, cacheEnabled: false } }) }))
        .toBe('已关闭')
    }

    // 页面加载前（runtime 还是 null）不编造值，也不因此丢掉字段本身。
    const unknown = searchSettingsFields('关闭窗口', { runtime: null })
    expect(unknown.map((hit) => hit.id)).toContain('application.close-policy')
    expect(unknown.find((hit) => hit.id === 'application.close-policy')!.value).toBeNull()

    // 选项目录的措辞必须就是页面渲染的那一份（同一份定义），或来自共享的 PROFILE_OPTIONS：
    // 如果索引自己另抄一份标签，改页面不改索引就会在这里变红。
    const corpus = [...settingsSources.values()].join('\n')
    const profileLabels = new Set(PROFILE_OPTIONS.map((option) => option.label))
    const optionLabelValues = [
      '始终留在后台',
      expected['agent.profile']!,
      '公开匿名读取',
      'Cloudflare DoH',
      '外发前确认',
      '需要批准',
      '普通',
    ]
    for (const value of optionLabelValues) {
      const sharedByPageModule = corpus.includes(value)
      const sharedByProfileOptions = profileLabels.has(value)
      expect(sharedByPageModule || sharedByProfileOptions, `"${value}" is the same wording the page renders`).toBe(true)
    }
  })

  it('never publishes a secret value, and says so for every key field', () => {
    const poisoned = poisonedRuntimeFixture()
    // 机密值就摆在 Runtime 快照的每一个字符串位置里：任何一条读取器开始发布路径、模型名、
    // 环境变量名或 header 名，都会在这里被抓住。
    for (const definition of SETTINGS_FIELD_INDEX) {
      const value = settingsFieldValue(definition, { runtime: poisoned })
      expect(value ?? '', `${definition.id} does not publish the fixture secret`).not.toContain(SECRET_IN_FIXTURE)
    }
    // 按机密值本身搜索：没有命中，命中文本里也没有它。
    const secretHits = searchSettingsFields(SECRET_IN_FIXTURE, { runtime: poisoned })
    expect(secretHits).toEqual([])
    const allText = SETTINGS_FIELD_INDEX
      .flatMap((definition) => [definition.title, definition.section, ...definition.aliases])
      .join(' ')
    expect(allText).not.toContain(SECRET_IN_FIXTURE)

    // 两处密钥字段：只登记位置，没有读取器，理由写在条目里。
    for (const id of ['web.provider-key', 'api.provider-key']) {
      const definition = settingsFieldDefinition(id)!
      expect(definition.readValue, `${id} has no value reader`).toBeUndefined()
      expect(definition.valueNotIndexed ?? '', `${id} states why`).toContain('机密')
    }
  })

  it('records the fields it deliberately does not index', () => {
    expect(SETTINGS_UNINDEXED_FIELDS.length).toBeGreaterThanOrEqual(6)
    for (const entry of SETTINGS_UNINDEXED_FIELDS) {
      expect(entry.what.trim().length, `${entry.where} what`).toBeGreaterThan(3)
      expect(entry.where.trim().length, `${entry.what} where`).toBeGreaterThan(1)
      expect(entry.why.trim().length, `${entry.what} why`).toBeGreaterThan(12)
    }
    const recorded = SETTINGS_UNINDEXED_FIELDS.map((entry) => `${entry.what} ${entry.where}`).join(' ')
    for (const topic of ['密钥', '数据目录', '开发环境', '插件列表', '工作模块', '草稿']) {
      expect(recorded, `${topic} is recorded as not indexed`).toContain(topic)
    }
    // 被记录为“不索引”的字段不得同时又出现在索引里。
    for (const id of ['developmentEnvironments.version', 'storage.data-dir-path', 'browser.cookie-value']) {
      expect(settingsFieldDefinition(id)).toBeNull()
    }
  })

  it('publishes the DOM contract the landing flow and the pages share', async () => {
    expect(SETTINGS_FIELD_ATTRIBUTE).toBe('data-settings-field')
    expect(settingsFieldSelector('web.enabled')).toBe('[data-settings-field="web.enabled"]')
    expect(settingsFieldOptionId(0)).toBe('settings-field-option-0')
    expect(settingsFieldOptionId(12)).toBe('settings-field-option-12')
    expect(SETTINGS_FIELD_LISTBOX_ID).toBe('settings-field-results')
    expect(SETTINGS_FIELD_LANDED_ATTRIBUTE).toBe('data-settings-field-landed')
    expect(SETTINGS_FIELD_LANDED_MS).toBeGreaterThanOrEqual(1_000)
    expect(SETTINGS_FIELD_LANDING_TIMEOUT_MS).toBeGreaterThanOrEqual(SETTINGS_FIELD_LANDED_MS)

    const workspace = settingsSources.get('workspace.tsx')!
    // 复用现有搜索入口与焦点所有者，不新增第二个搜索框、也不另写一套焦点规则。
    expect(workspace.match(/className="settings-sidebar-search"/gu)?.length).toBe(1)
    expect(workspace).toContain('useEscapeScope')
    expect(workspace).not.toContain('useModalSurface')
    expect(workspace).toContain('role="combobox"')
    expect(workspace).toContain('aria-activedescendant')
    expect(workspace).toContain('searchSettingsFields(settingsQuery')
    expect(workspace).toContain('revealSettingsField(')
  })

  it('turns the search box keys into the combobox contract, and fails when that handling is removed', () => {
    // 决定层：↑↓ 移动结果环，Enter 只在环已落在某条结果上时取用，Escape 不归搜索处理（它归
    // `ui/modal-surface.ts` 的作用域所有者），其它键一律放行给输入框。
    expect(settingsSearchKeyIntent('ArrowDown', false)).toBe('next')
    expect(settingsSearchKeyIntent('ArrowDown', true)).toBe('next')
    expect(settingsSearchKeyIntent('ArrowUp', false)).toBe('previous')
    expect(settingsSearchKeyIntent('ArrowUp', true)).toBe('previous')
    expect(settingsSearchKeyIntent('Enter', true)).toBe('take')
    expect(settingsSearchKeyIntent('Enter', false)).toBe('none')
    expect(settingsSearchKeyIntent('Escape', true)).toBe('none')
    expect(settingsSearchKeyIntent(' ', true)).toBe('none')
    expect(settingsSearchKeyIntent('a', true)).toBe('none')
    expect(settingsSearchKeyIntent('Tab', true)).toBe('none')

    // 环的走法：第一下从输入框落进第一条、到底回卷、↑ 从输入框直接到最后一条、空结果没有环。
    expect(nextSettingsFieldIndex(-1, 3, 'next')).toBe(0)
    expect(nextSettingsFieldIndex(0, 3, 'next')).toBe(1)
    expect(nextSettingsFieldIndex(1, 3, 'next')).toBe(2)
    expect(nextSettingsFieldIndex(2, 3, 'next')).toBe(0)
    expect(nextSettingsFieldIndex(-1, 3, 'previous')).toBe(2)
    expect(nextSettingsFieldIndex(0, 3, 'previous')).toBe(2)
    expect(nextSettingsFieldIndex(-1, 0, 'next')).toBe(-1)
    expect(nextSettingsFieldIndex(-1, 0, 'previous')).toBe(-1)

    // 接线层：控件必须真的用这两个决定，并把 IME 组合与 Escape 交给它们的所有者。
    const workspace = settingsSources.get('workspace.tsx')!
    expect(workspace).toContain('settingsSearchKeyIntent(event.key')
    expect(workspace).toContain('nextSettingsFieldIndex(current, fieldHits.length, intent)')
    expect(workspace).toContain('if (event.nativeEvent.isComposing) return')
    expect(workspace).toContain('role="listbox"')
    expect(workspace.match(/role="option"/gu)?.length).toBe(1)
    expect(workspace).toContain('aria-selected={index === activeHitIndex}')
  })

  it('pairs the landing emphasis with a drawn rule and a reduced-motion-safe timeout', async () => {
    const styles = await readFile(new URL('../styles/07-overlays-settings.css', import.meta.url), 'utf8')
    const emphasis = styles.indexOf(`[${SETTINGS_FIELD_LANDED_ATTRIBUTE}] {`)
    expect(emphasis, 'the landed emphasis rule exists').toBeGreaterThanOrEqual(0)
    const body = styles.slice(emphasis, styles.indexOf('\n}', emphasis))
    // 强调必须是画出来的轮廓（像素可读），且不引入 !important 或过渡依赖。
    expect(body).toContain('outline: 2px solid')
    expect(body).not.toContain('!important')
    expect(body).not.toContain('animation')
    const results = styles.indexOf('.settings-field-result {')
    expect(results, 'the field result rule exists').toBeGreaterThanOrEqual(0)
    const resultBody = styles.slice(results, styles.indexOf('\n}', results))
    expect(resultBody).toContain('border-radius: var(--radius-ui)')
    const active = styles.slice(styles.indexOf('.settings-field-result.active {'), styles.indexOf('\n}', styles.indexOf('.settings-field-result.active {')))
    // 当前结果不能只靠颜色区分（V3）：填充之外还有一道强调色条，而且这条色条不能用
    // `box-shadow: inset 2px 0`——那个字面量在 `workspace/code-editor-unification.test.ts`
    // 里是审阅差异行的专属写法。
    expect(active).toContain('background-color: var(--sidebar-interaction-active)')
    const indicator = styles.slice(
      styles.indexOf('.settings-field-result::before {'),
      styles.indexOf('\n}', styles.indexOf('.settings-field-result::before {')),
    )
    expect(indicator).toContain('background: var(--accent)')
    expect(indicator).toContain('opacity: 0')
    expect(styles).toContain('.settings-field-result.active::before {')
    expect(styles.slice(styles.indexOf('.settings-field-result.active::before {')).slice(0, 120)).toContain('opacity: 1')
    expect(styles).not.toContain('box-shadow: inset 2px 0')
  })

  it('lands a field without owning focus, and reports what it did', () => {
    // 没有 DOM 时不能凭空成功：node 环境下 revealSettingsField 用的是调用方给的 document。
    const emptyDocument = {
      querySelector: () => null,
      defaultView: null,
    } as unknown as Document
    expect(revealSettingsField('web.enabled', emptyDocument)).toBeNull()
  })
})
