// The action-glyph table (V2 「图标语义与可发现性」).
//
// V2 asks for one picture per action, an optical size that does not depend on which page
// drew the glyph, and a name on every icon-only control. This file *is* that table, as
// data, and every assertion below fails when a row stops being true:
//
//   - `GLYPHS` covers every `*Icon` the five shared families export. A new glyph, a renamed
//     export or a deleted one fails until the row is updated - which is also what keeps the
//     frozen `icons.tsx` hotspot honest (V2: 避免扩大集中图标文件), and what turned the dead
//     `PanelCollapseIcon` (0 consumers repo-wide) red before this change;
//   - `census` is the rendered composition of each glyph, so a redraw - a filled lens where
//     an outline belongs, a ring instead of a dot - has to be written down here;
//   - several glyphs may share one `action` only if they draw the same silhouette, which is
//     how `dismiss` keeps the sidebar cross and the tab cross the same picture, and two
//     different actions may never draw byte-identical markup;
//   - `ICON_ONLY_CONTROLS` pins the accessible name at every icon-only render site;
//   - `ICON_STROKE_RULES` pins the optical stroke of the two action families to the single
//     `--icon-stroke` token and registers every other stroke decision in those sheets.
//
// The human-readable half of the table (which surface draws what) is in `ui/README.md`.
import * as React from 'react'
import { readdir, readFile } from 'node:fs/promises'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { readRendererStyleSourceFiles } from '../style-source-test-utils'
import * as browserIcons from './browser-icons'
import * as fileGlyphs from './file-glyph-icons'
import * as icons from './icons'
import * as messageIcons from './message-icons'
import * as stateIcons from './state-icons'

vi.stubGlobal('React', React)

type ModuleName = 'icons.tsx' | 'message-icons.tsx' | 'browser-icons.tsx' | 'file-glyph-icons.tsx' | 'state-icons.tsx'

const MODULES: Record<ModuleName, Record<string, unknown>> = {
  'icons.tsx': icons,
  'message-icons.tsx': messageIcons,
  'browser-icons.tsx': browserIcons,
  'file-glyph-icons.tsx': fileGlyphs,
  'state-icons.tsx': stateIcons,
}

/** glyph, module, action, rendered census. Parameterised glyphs carry `variants`. */
type GlyphRow = readonly [glyph: string, module: ModuleName, action: string, census: string]

const GLYPHS: readonly GlyphRow[] = [
  // Shell, settings and sidebar entries.
  ['SidebarToggleIcon', 'icons.tsx', 'toggle-sidebar', 'rect path'],
  ['SettingsGearIcon', 'icons.tsx', 'open-settings', 'path circle'],
  ['NavComposeIcon', 'icons.tsx', 'compose-global', 'path'],
  ['ComposeIcon', 'icons.tsx', 'create-in-list', 'rect path'],
  ['SearchIcon', 'icons.tsx', 'search-filter', 'circle path'],
  ['ScheduleIcon', 'icons.tsx', 'scheduled-module', 'circle path'],
  ['MemoryTreeNavIcon', 'icons.tsx', 'memory-tree-module', 'dot dot dot path'],
  ['PluginIcon', 'icons.tsx', 'plugins-module', 'path'],
  ['ProjectIcon', 'icons.tsx', 'project', 'path'],
  ['SettingsNavArrowIcon', 'icons.tsx', 'open-details', 'path'],
  // Row and menu actions.
  ['MoreIcon', 'icons.tsx', 'more-actions', 'dot dot dot'],
  ['PinIcon', 'icons.tsx', 'pin-session', 'variants'],
  ['RenameIcon', 'icons.tsx', 'rename', 'path'],
  ['CheckIcon', 'icons.tsx', 'done-confirm', 'path'],
  ['SortIcon', 'icons.tsx', 'sort', 'path'],
  ['ArchiveIcon', 'icons.tsx', 'archive', 'path'],
  ['TrashIcon', 'icons.tsx', 'delete', 'path'],
  ['RefreshIcon', 'icons.tsx', 'refresh', 'path'],
  // Dismiss: one picture, two optical sizes (the tab strip's cross is the same cross).
  ['CloseIcon', 'icons.tsx', 'dismiss', 'path'],
  ['CloseMiniIcon', 'icons.tsx', 'dismiss', 'path'],
  // Workspace panel and its toolbar.
  ['WorkspacePanelIcon', 'icons.tsx', 'toggle-workspace-panel', 'rect path path'],
  ['PanelFullscreenIcon', 'icons.tsx', 'fullscreen-panel', 'variants'],
  ['TreeChevronIcon', 'icons.tsx', 'tree-chevron', 'path'],
  ['VSCodeIcon', 'icons.tsx', 'open-vscode', 'path path'],
  ['ExternalOpenIcon', 'icons.tsx', 'open-external', 'path'],
  ['HistoryBackIcon', 'browser-icons.tsx', 'history-back', 'path path'],
  ['HistoryForwardIcon', 'browser-icons.tsx', 'history-forward', 'path path'],
  ['BrowserNewTabIcon', 'browser-icons.tsx', 'browser-new-tab', 'rect path'],
  // Composer.
  ['SendRunIcon', 'icons.tsx', 'run-send', 'path'],
  ['StopRunIcon', 'icons.tsx', 'run-stop', 'rect'],
  ['ModeRiskIcon', 'icons.tsx', 'permission-risk', 'variants'],
  // Message row.
  ['CopyIcon', 'message-icons.tsx', 'copy', 'rect rect'],
  ['BranchIcon', 'message-icons.tsx', 'branch', 'path dot dot'],
  ['UsageIcon', 'message-icons.tsx', 'usage', 'ellipse path path'],
  // File types keep their own recognition colours and marks (see the colour check below).
  ['FolderGlyphIcon', 'file-glyph-icons.tsx', 'folder-type', 'path path'],
  ['FileGlyphIcon', 'file-glyph-icons.tsx', 'file-type', 'variants'],
  ['WorkspaceFeatureIcon', 'icons.tsx', 'workspace-feature', 'variants'],
  // State marks (V3): one glyph per state, never a second picture for the same state.
  ['FailureIcon', 'state-icons.tsx', 'state-failure', 'circle path circle'],
  ['WarningIcon', 'state-icons.tsx', 'state-warning', 'path path path'],
  ['SuccessIcon', 'state-icons.tsx', 'state-success', 'circle path'],
  ['InfoIcon', 'state-icons.tsx', 'state-info', 'circle path path'],
  ['UnavailableIcon', 'state-icons.tsx', 'state-unavailable', 'circle path'],
  ['EmptyIcon', 'state-icons.tsx', 'state-empty', 'path path'],
]

/**
 * Glyphs that render a different mark per prop. Their per-variant census is pinned here,
 * because one row cannot describe six drawings. `FileGlyphIcon` loads local vector format marks;
 * its composition is pinned by `icons.test.ts`. Neutral outlines are registered below.
 */
const VARIANTS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  PinIcon: [['inactive', 'path'], ['active', 'path']],
  PanelFullscreenIcon: [['inactive', 'path'], ['active', 'path']],
  ModeRiskIcon: [['normal', 'circle circle'], ['warning', 'circle rect circle']],
  WorkspaceFeatureIcon: [
    ['files', 'path'], ['review', 'rect path path'], ['terminal', 'rect path'],
    ['artifacts', 'path path path'], ['browser', 'circle path'], ['sideChat', 'path path'],
  ],
  FileGlyphIcon: [],
}

/** The human name the product uses for each action, quoted from the control that draws it. */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'toggle-sidebar': '收起侧栏 / 展开侧栏',
  'open-settings': '设置 / 关闭设置',
  'compose-global': '新对话',
  'create-in-list': '新对话 / 添加项目',
  'search-filter': '搜索 / 筛选文件 / 筛选更改文件',
  'scheduled-module': '已安排',
  'memory-tree-module': '记忆树',
  'plugins-module': '插件',
  project: '项目',
  'open-details': '展开分组',
  'more-actions': '更多操作',
  'pin-session': '置顶 / 取消置顶',
  rename: '重命名',
  'done-confirm': '已完成',
  sort: '排序',
  archive: '归档',
  delete: '删除',
  refresh: '刷新',
  dismiss: '关闭',
  'toggle-workspace-panel': '收起工作区 / 展开工作区',
  'fullscreen-panel': '全屏 / 退出全屏',
  'tree-chevron': '展开 / 收起',
  'open-vscode': '用外部 VS Code 打开工作区',
  'open-external': '用系统默认应用打开',
  'history-back': '返回',
  'history-forward': '前进',
  'browser-new-tab': '新建浏览器标签',
  'run-send': '发送',
  'run-stop': '停止',
  'permission-risk': '权限模式风险标记',
  copy: '复制消息',
  branch: '从这里分叉对话',
  usage: '本轮用量与缓存命中',
  'folder-type': '文件夹',
  'file-type': '文件类型',
  'workspace-feature': '工作区功能入口',
  'state-failure': '失败',
  'state-warning': '警告',
  'state-success': '成功',
  'state-info': '信息',
  'state-unavailable': '不可用',
  'state-empty': '无数据',
}

/** Icon-only controls: the glyph is the whole control, so its name is the only name. */
const ICON_ONLY_CONTROLS: ReadonlyArray<readonly [file: string, glyph: string, name: string]> = [
  ['sidebar/quick-nav.tsx', 'NavComposeIcon', 'label="新对话"'],
  ['sidebar/quick-nav.tsx', 'SearchIcon', 'label="搜索"'],
  ['sidebar/quick-nav.tsx', 'MemoryTreeNavIcon', 'label="记忆树"'],
  ['sidebar/quick-nav.tsx', 'ScheduleIcon', 'label="已安排"'],
  ['sidebar/quick-nav.tsx', 'PluginIcon', 'label="插件"'],
  ['sidebar/global-titlebar.tsx', 'SettingsGearIcon', "aria-label={settingsOpen ? '关闭设置' : '设置'}"],
  ['sidebar/global-titlebar.tsx', 'SidebarToggleIcon', 'aria-label={sidebarToggleTip}'],
  ['sidebar/global-titlebar.tsx', 'HistoryBackIcon', 'aria-label="返回"'],
  ['sidebar/global-titlebar.tsx', 'HistoryForwardIcon', 'aria-label="前进"'],
  ['sidebar/session-row.tsx', 'PinIcon', 'aria-label={pinLabel}'],
  ['sidebar/session-row.tsx', 'ArchiveIcon', 'aria-label="归档对话"'],
  ['sidebar/session-row.tsx', 'MoreIcon', 'label={menuLabel}'],
  ['sidebar/project-section.tsx', 'ComposeIcon', 'aria-label="添加项目"'],
  ['app-shell/conversation-section-view.tsx', 'ComposeIcon', 'aria-label={newConversationTip}'],
  ['app-shell/composer-view.tsx', 'StopRunIcon', 'aria-label={stopActionTip}'],
  ['chat/message-meta.tsx', 'CopyIcon', 'aria-label={copyState'],
  ['chat/message-meta.tsx', 'BranchIcon', 'aria-label="从这里分叉对话"'],
  ['composer/message-files.tsx', 'ExternalOpenIcon', 'aria-label={`用系统默认应用打开'],
  ['composer/message-files.tsx', 'CloseIcon', 'aria-label={`移除 ${name}`}'],
  ['runtime-recovery/checkpoint-recovery.tsx', 'CloseIcon', 'aria-label="稍后处理"'],
  ['workspace/file-navigator.tsx', 'VSCodeIcon', 'aria-label="用外部 VS Code 打开工作区"'],
  ['workspace/file-navigator.tsx', 'RefreshIcon', 'aria-label="刷新文件树"'],
  ['workspace/panel.tsx', 'PanelFullscreenIcon', 'aria-label={fullscreenTip}'],
  ['workspace/tab-strip.tsx', 'CloseMiniIcon', 'aria-label={`关闭${entry.label}标签`}'],
  ['MemoryTreeView.tsx', 'RefreshIcon', 'aria-label="刷新记忆文件"'],
]

/** Every `stroke-width` the two action families are drawn with (V2 光学尺寸). */
const ICON_STROKE_RULES: ReadonlyArray<readonly [sheet: string, selector: string, value: string]> = [
  ['./styles/03-shell-sidebar.css', '.sidebar-toggle-outline, .sidebar-toggle-divider', '1'],
  ['./styles/03-shell-sidebar.css', '.settings-gear-icon', '2.15'],
  ['./styles/03-shell-sidebar.css', '.sidebar-svg-icon', 'var(--icon-stroke)'],
  ['./styles/04-workspace.css', '.workspace-panel-svg-icon path, .workspace-panel-svg-icon rect, .workspace-panel-svg-icon circle, .workspace-panel-svg-icon ellipse', 'var(--icon-stroke)'],
  ['./styles/04-workspace.css', '.history-navigation-icon .workspace-browser-arrow-shaft, .history-navigation-icon .workspace-browser-arrow-head', 'var(--icon-stroke)'],
  ['./styles/04-workspace.css', '.workspace-tree-chevron-icon path, .workspace-tree-glyph-icon path', '1.35'],
  ['./styles/04-workspace.css', '.workspace-tree-glyph-icon.file-glyph-icon .file-glyph-sheet, .workspace-tree-glyph-icon.file-glyph-icon .file-glyph-fold', '1.2'],
  ['./styles/04-workspace.css', '.workspace-tree-glyph-icon.folder-glyph-icon .folder-glyph-body', '1.2'],
  ['./styles/04-workspace.css', '.workspace-tree-glyph-icon.folder-glyph-icon .folder-glyph-seam', '1.2'],
  ['./styles/04-workspace.css', '.workspace-tree-glyph-icon.file-glyph-image .file-glyph-image-frame, .workspace-tree-glyph-icon.file-glyph-image .file-glyph-image-mountains', '1.2'],
  ['./styles/04-workspace.css', '.split-button-chevron-icon', '1.5'],
]

/** Imported assets own their colours. CSS only paints the neutral fallback, folder and image. */
const FILE_GLYPH_COLOURS: ReadonlyArray<readonly [typeClass: string, fill: string]> = [
  ['file-glyph-fold', 'none'],
  ['folder-glyph-body', 'color-mix(in srgb, currentColor 10%, transparent)'],
  ['folder-glyph-seam', 'none'],
  ['file-glyph-image-sun', 'currentColor'],
  ['file-glyph-image-mountains', 'none'],
]

/** The families that must share one optical stroke, through one token. */
const SHARED_STROKE_FAMILIES = ['.sidebar-svg-icon', '.workspace-panel-svg-icon']
interface Rule {
  file: string
  selector: string
  body: string
}

async function readRendererFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

/** Renderer components, excluding the shared icon families themselves. */
async function findRendererSources(): Promise<Array<{ path: string; source: string }>> {
  const sources: Array<{ path: string; source: string }> = []
  async function walk(directory: URL, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'assets') continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(new URL(`${entry.name}/`, directory), relative)
        continue
      }
      if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) continue
      if (relative.startsWith('ui/') && !relative.includes('/')) continue
      sources.push({ path: relative, source: await readFile(new URL(entry.name, directory), 'utf8') })
    }
  }
  await walk(new URL('../', import.meta.url), '')
  return sources
}

function render(glyph: string, module: ModuleName, props: Record<string, unknown> = {}): string {
  const component = MODULES[module][glyph] as (input: Record<string, unknown>) => React.ReactElement
  expect(component, `${glyph} is not exported by ${module}`).toBeTypeOf('function')
  return renderToStaticMarkup(React.createElement(component, props))
}

/** The rendered marks in order: one entry per drawn shape, with the solid marks named. */
function censusOf(markup: string): string {
  return [...markup.matchAll(/<(path|circle|ellipse|rect|line|polyline|polygon)\b([^>]*)>/gu)]
    .map((match) => {
      const tag = match[1]!
      const attributes = match[2] ?? ''
      return (tag === 'circle' || tag === 'ellipse') && /class="[^"]*\bicon-dot\b/u.test(attributes) ? 'dot' : tag
    })
    .join(' ')
}

/** The drawing itself, independent of where it sits: subpath count and line/curve per path. */
function shapeOf(markup: string): string {
  return [...markup.matchAll(/<(path|circle|ellipse|rect|line|polyline|polygon)\b([^>]*)>/gu)]
    .map((match) => {
      const tag = match[1]!
      if (tag !== 'path') return tag
      const data = / d="([^"]*)"/u.exec(match[2] ?? '')?.[1] ?? ''
      const subpaths = data.split(/[Mm]/u).length - 1
      return `path:${subpaths}${/[CcSsQqTtAa]/u.test(data) ? 'c' : 'l'}`
    })
    .join(' ')
}

function rulesOf(files: Array<{ path: string; source: string }>): Rule[] {
  return files.flatMap(({ path, source }) => {
    const withoutComments = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '')
    return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .map((match) => ({ file: path, selector: (match[1] ?? '').replaceAll(/\s+/gu, ' ').trim(), body: match[2] ?? '' }))
      .filter((rule) => rule.selector.length > 0 && !rule.selector.startsWith('@'))
  })
}

function declarationOf(body: string, property: string): string | null {
  return new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, 'u').exec(body)?.[1]?.trim() ?? null
}

const styleFiles = await readRendererStyleSourceFiles()
const styleRules = rulesOf(styleFiles.map(({ path, source }) => ({ path, source })))
const actionSheets = styleFiles.filter(({ path }) => path.endsWith('03-shell-sidebar.css') || path.endsWith('04-workspace.css'))

describe('action glyph table', () => {
  it('lists every glyph the shared families export, and no others', async () => {
    expect(GLYPHS).toHaveLength(43)
    // Counted from each module's own source, so a re-export in `icons.tsx`
    // (`FileGlyphIcon`, `CopyIcon`, …) is the module that draws it, not a second glyph.
    const exported: Array<readonly [string, ModuleName]> = []
    for (const [module, family] of Object.entries(MODULES) as Array<[ModuleName, Record<string, unknown>]>) {
      const source = await readFile(new URL(module, import.meta.url), 'utf8')
      for (const match of source.matchAll(/export function (\w+)/gu)) {
        const name = match[1]!
        // `fileGlyphKind` classifies a file name; it draws nothing.
        if (!name.endsWith('Icon')) continue
        expect(family[name], `${module} does not export ${name}`).toBeTypeOf('function')
        exported.push([name, module])
      }
    }
    expect(exported.map(([name]) => name).sort()).toEqual(GLYPHS.map(([glyph]) => glyph).sort())
    for (const [glyph, module] of exported) {
      expect(GLYPHS.find((row) => row[0] === glyph)?.[1], `${glyph} is listed under the wrong module`).toBe(module)
    }
    for (const [glyph, , action] of GLYPHS) {
      expect(ACTION_LABELS[action], `${glyph} has no action label`).toBeTruthy()
    }
  })

  it('renders at least once outside the icon families, so no glyph is dead weight', async () => {
    const sources = await findRendererSources()
    const dead = GLYPHS
      .filter(([glyph]) => !sources.some(({ source }) => new RegExp(`<${glyph}[\\s/>]`, 'u').test(source)))
      .map(([glyph]) => glyph)
    expect(dead, 'a glyph nobody renders belongs next to its one consumer, not in the shared set').toEqual([])
  })

  it('draws the composition the table records, hidden from assistive tech', () => {
    for (const [glyph, module, , census] of GLYPHS) {
      if (census === 'variants') continue
      const markup = render(glyph, module)
      expect(censusOf(markup), `${glyph} (${module}) changed shape`).toBe(census)
      // Decorative by contract: the control around the glyph carries the name.
      expect(markup, `${glyph} must stay hidden from assistive tech`).toContain('aria-hidden="true"')
      expect(markup, `${glyph} must not be a tab stop`).toContain('focusable="false"')
    }
  })

  it('draws each variant of a parameterised glyph as the table records', () => {
    for (const [glyph, variants] of Object.entries(VARIANTS)) {
      for (const [variant, census] of variants) {
        const props = glyph === 'WorkspaceFeatureIcon'
          ? { id: variant }
          : glyph === 'ModeRiskIcon'
            ? { risk: variant === 'warning' ? 'high' : 'low', className: 'mode-risk-icon' }
            : { active: variant === 'active' }
        expect(censusOf(render(glyph, 'icons.tsx', props)), `${glyph} ${variant}`).toBe(census)
      }
    }
  })

  it('keeps one picture per action, and a different picture per action', () => {
    const byAction = new Map<string, GlyphRow[]>()
    for (const row of GLYPHS) {
      if (row[3] === 'variants') continue
      byAction.set(row[2], [...(byAction.get(row[2]) ?? []), row])
    }
    for (const [action, rows] of byAction) {
      if (rows.length < 2) continue
      const shapes = rows.map(([glyph, module]) => `${glyph}: ${shapeOf(render(glyph, module))}`)
      const distinct = new Set(shapes.map((entry) => entry.slice(entry.indexOf(': ') + 2)))
      expect(distinct.size, `${action} draws ${shapes.join(' vs ')}`).toBe(1)
    }
    for (const module of Object.keys(MODULES) as ModuleName[]) {
      const drawn = new Map<string, string>()
      for (const [glyph, glyphModule] of GLYPHS.map((row) => [row[0], row[1]] as const)) {
        if (glyphModule !== module || VARIANTS[glyph] !== undefined) continue
        const markup = render(glyph, module).replaceAll(/\s+/gu, ' ')
        const twin = drawn.get(markup)
        expect(twin, `${glyph} and ${twin} draw the same picture for two different actions`).toBeUndefined()
        drawn.set(markup, glyph)
      }
    }
  })

  it('names every icon-only control it lists', async () => {
    expect(ICON_ONLY_CONTROLS).toHaveLength(25)
    for (const [file, glyph, name] of ICON_ONLY_CONTROLS) {
      const source = await readRendererFile(file)
      expect(source, `${file} no longer renders ${glyph}`).toMatch(new RegExp(`<${glyph}[\\s/>]`, 'u'))
      expect(source, `${file}: ${glyph} lost its accessible name (${name})`).toContain(name)
    }
  })

  it('fills only the marks that are meant to be solid', () => {
    // The stylesheet half of the dot/ring contract: one rule, and it can only match a mark
    // that asked for it. A bare `.sidebar-svg-icon circle` rule is the defect this pins.
    const filling = styleRules.filter((rule) => (
      rule.selector.includes('.sidebar-svg-icon') && declarationOf(rule.body, 'fill') === 'currentColor'
    ))
    expect(filling.map((rule) => rule.selector)).toEqual(['.sidebar-svg-icon circle.icon-dot'])
    const bare = styleRules.filter((rule) => /\.sidebar-svg-icon\s+circle\s*$/u.test(rule.selector))
    expect(bare, 'a bare circle rule fills every outline again').toEqual([])
    const family = styleRules.find((rule) => rule.selector === '.sidebar-svg-icon')
    expect(declarationOf(family?.body ?? '', 'fill')).toBe('none')
    // And the glyph half: the two outline-only glyphs really are outlines.
    for (const glyph of ['SearchIcon', 'ScheduleIcon'] as const) {
      expect(censusOf(render(glyph, 'icons.tsx')), `${glyph} must draw its circle as an outline`).toBe('circle path')
    }
  })

  it('draws both action families at one optical stroke', () => {
    // The token exists once, and it is a real weight rather than a hairline.
    const tokenRules = styleRules.filter((rule) => declarationOf(rule.body, '--icon-stroke') !== null)
    expect(tokenRules).toHaveLength(1)
    const token = declarationOf(tokenRules[0]!.body, '--icon-stroke') ?? ''
    expect(token.endsWith('px')).toBe(true)
    expect(Number.parseFloat(token)).toBeGreaterThanOrEqual(1.4)
    expect(Number.parseFloat(token)).toBeLessThanOrEqual(1.6)

    // Both families declare that token, so the stroke is the same number of CSS pixels at a
    // 10px box and at an 18px one. `vector-effect` is *not* inherited: it has to sit on the
    // shapes that are stroked, and on the `<svg>` it silently does nothing (the family then
    // keeps scaling - 0.94px at 10px, 1.69px at 18px, measured in headless Chromium).
    for (const name of SHARED_STROKE_FAMILIES) {
      const rule = styleRules.find((candidate) => (
        (candidate.selector === name || candidate.selector.startsWith(`${name} `))
        && declarationOf(candidate.body, 'stroke-width') !== null
      ))
      expect(rule, `${name} has no stroke rule`).toBeDefined()
      expect(declarationOf(rule!.body, 'stroke-width'), `${name} stopped using the shared stroke`).toBe('var(--icon-stroke)')
      const shapes = styleRules.filter((candidate) => candidate.selector.includes(`${name} path`))
      expect(shapes.length, `${name} has no shape rule`).toBeGreaterThan(0)
      expect(
        shapes.some((candidate) => declarationOf(candidate.body, 'vector-effect') === 'non-scaling-stroke'),
        `${name} does not turn stroke scaling off on its shapes`,
      ).toBe(true)
      const root = styleRules.find((candidate) => candidate.selector === name)
      expect(
        declarationOf(root?.body ?? '', 'vector-effect'),
        `${name} declares vector-effect on the <svg>, where it is inert`,
      ).toBeNull()
    }

    // Every other stroke decision in these two sheets is registered, so a new icon family
    // arrives as a reviewed table row instead of a third number.
    const declared = new Set(ICON_STROKE_RULES.map(([sheet, selector, value]) => `${sheet}|${selector}|${value}`))
    const strokes = rulesOf(actionSheets.map(({ path, source }) => ({ path, source })))
      .filter((rule) => declarationOf(rule.body, 'stroke-width') !== null)
    expect(strokes).toHaveLength(ICON_STROKE_RULES.length)
    expect(strokes
      .map((rule) => `${rule.file}|${rule.selector}|${declarationOf(rule.body, 'stroke-width')}`)
      .filter((entry) => !declared.has(entry)), 'register the new stroke in ICON_STROKE_RULES, or reuse --icon-stroke').toEqual([])

    // Glyph boxes stay whole pixels: a fractional box is what a 100%/150%/200% display has
    // to resample into a smudge.
    for (const rule of styleRules) {
      if (!SHARED_STROKE_FAMILIES.some((name) => rule.selector.includes(name))) continue
      for (const property of ['width', 'height'] as const) {
        const value = declarationOf(rule.body, property)
        if (value === null || !value.endsWith('px')) continue
        expect(Number.isInteger(Number.parseFloat(value)), `${rule.selector} draws at ${value}`).toBe(true)
      }
    }
  })

  it('keeps the file-type recognition colours', () => {
    const colours = rulesOf(actionSheets.map(({ path, source }) => ({ path, source })))
      .filter((rule) => /\.(?:file|folder)-glyph-[\w-]+/u.test(rule.selector) && declarationOf(rule.body, 'fill') !== null)
      .map((rule) => {
        const classes = [...rule.selector.matchAll(/\.((?:file|folder)-glyph-[\w-]+)/gu)].map((match) => match[1]!)
        // The subject of the rule is its last class; the ones before it are the ancestors.
        return [classes.at(-1)!, declarationOf(rule.body, 'fill')!] as const
      })
      .sort((left, right) => left[0].localeCompare(right[0]))
    expect(colours).toEqual([...FILE_GLYPH_COLOURS].sort((left, right) => left[0].localeCompare(right[0])))
  })
})
