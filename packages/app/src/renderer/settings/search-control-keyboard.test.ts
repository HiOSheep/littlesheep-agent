import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FOCUSABLE_SELECTOR } from '../ui/modal-layer'
import {
  SETTINGS_FIELD_ATTRIBUTE,
  SETTINGS_FIELD_LANDED_ATTRIBUTE,
  SETTINGS_FIELD_LANDED_MS,
  nextSettingsFieldIndex,
  revealSettingsField,
  searchSettingsFields,
  settingsFieldSelector,
  settingsSearchKeyIntent,
} from './search-index'

/**
 * S3 的键盘验收：**控件这一侧**。
 *
 * `search-index.test.ts` 钉住的是决定层（`settingsSearchKeyIntent` / `nextSettingsFieldIndex` 的
 * 取值）以及它们在控件源码里出现过。那一半删掉处理函数会红，但**拆掉接线不会**：把
 * `onKeyDown={onSearchKeyDown}` 从 `<input>` 上拿掉之后，处理函数、两个决定函数和那些字面量都还
 * 在，搜索框却再也收不到按键。这个文件补的正是那一半：
 *
 *   ① 键盘接线与 combobox 的 aria 契约挂在**同一个** `<input>` 元素上；
 *   ② 键入 → 方向键 → 回车这条链在 node 里真的跑完，光标落到 `data-settings-field` 那一行；
 *   ③ Escape 的效果只有「关列表 + 还焦点」，没有清查询、翻页、关设置、落地；
 *   ④ 环上的那一条会被滚进视野，而不是停在 `.settings-nav-section` 这个滚动视口之外。
 *
 * 窗口里那一次真实按键（CDP `Input.dispatchKeyEvent`，可见且聚焦的窗口）另有证据，在仓库外
 * `D:\littlesheep-evidence\S3-2026-09-29\`；这里跑的是同一份代码的确定性版本。
 */
describe('settings search control keyboard (S3)', () => {
  beforeAll(() => {
    // `revealSettingsField` 用 `parent instanceof HTMLDetailsElement` 判断折叠区，node 里没有这个
    // 全局构造器，所以给一个替身；只有这一条真实分支需要它。
    vi.stubGlobal('HTMLDetailsElement', FakeDetailsElement)
  })
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  /**
   * `revealSettingsField` 用到的 DOM 能力就这几个；给一份最小实现，让「回车落到那一行」在 node
   * 里真的执行一遍，而不是断言它“看起来会执行”。形状照着真实页面：带锚点的元素是
   * `<div>` / `<label>` / `<section>` 容器（自己不可聚焦），可聚焦的控件在它里面；动作行没有控件。
   */
  class FakeDetailsElement {
    open = false
    parentElement: FakeDetailsElement | null = null
  }

  class FakeControl {
    constructor(private readonly doc: FakeDocument) {}
    focus(): void {
      this.doc.activeElement = this
    }
  }

  class FakeRow {
    readonly attributes = new Map<string, string>()
    readonly scrolls: Array<ScrollIntoViewOptions | undefined> = []
    readonly control: FakeControl | null
    tabIndex = 0
    parentElement: FakeDetailsElement | null = null

    constructor(private readonly doc: FakeDocument, readonly id: string, withControl: boolean) {
      this.attributes.set(SETTINGS_FIELD_ATTRIBUTE, id)
      this.control = withControl ? new FakeControl(doc) : null
    }

    matches(_selector: string): boolean {
      return false
    }

    querySelector(selector: string): FakeControl | null {
      return selector === FOCUSABLE_SELECTOR ? this.control : null
    }

    scrollIntoView(options?: ScrollIntoViewOptions): void {
      this.scrolls.push(options)
    }

    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value)
    }

    removeAttribute(name: string): void {
      this.attributes.delete(name)
    }

    focus(): void {
      this.doc.activeElement = this
    }
  }

  class FakeDocument {
    activeElement: FakeControl | FakeRow | null = null
    readonly rows: FakeRow[] = []
    readonly timeouts: Array<{ handler: () => void; ms: number }> = []
    readonly defaultView = {
      setTimeout: (handler: () => void, ms: number) => {
        this.timeouts.push({ handler, ms })
        return this.timeouts.length
      },
    }

    add(row: FakeRow): FakeRow {
      this.rows.push(row)
      return row
    }

    querySelector(selector: string): FakeRow | null {
      return this.rows.find((row) => selector === settingsFieldSelector(row.id)) ?? null
    }

    asDocument(): Document {
      return this as unknown as Document
    }
  }

  async function workspaceSource(): Promise<string> {
    return readFile(new URL('./workspace.tsx', import.meta.url), 'utf8')
  }

  it('keeps the keyboard wiring on the input itself, not only somewhere in the file', async () => {
    const workspace = await workspaceSource()
    // 只取 JSX 里那个元素：注释里也出现过 `<input type="search">` 这个写法，按行首标签定位。
    const element = /<input\s*\n/u.exec(workspace)
    expect(element, 'the search control renders an <input> element').not.toBeNull()
    const inputStart = element!.index
    const input = workspace.slice(inputStart, workspace.indexOf('/>', inputStart))

    // 键盘接线、搜索框角色、`aria-activedescendant` 必须在同一个元素上：只把处理函数留在文件里
    // 不算接线，搜索框收不到按键，`aria-activedescendant` 也没有宿主。
    for (const prop of [
      'ref={searchInputRef}',
      'onChange={(event) => changeSearchQuery(event.target.value)}',
      'onKeyDown={onSearchKeyDown}',
      'role="combobox"',
      'aria-autocomplete="list"',
      'aria-expanded={fieldResultsVisible}',
      'aria-controls={fieldResultsVisible ? SETTINGS_FIELD_LISTBOX_ID : undefined}',
      'aria-activedescendant={activeHitIndex >= 0 ? settingsFieldOptionId(activeHitIndex) : undefined}',
    ]) {
      expect(input, `输入框带 ${prop}`).toContain(prop)
    }

    // 处理函数走的是那两个决定，并且让位给 IME 与 Escape 的所有者。
    const handlerStart = workspace.indexOf('function onSearchKeyDown(')
    expect(handlerStart, 'the handler exists').toBeGreaterThanOrEqual(0)
    const handler = workspace.slice(handlerStart, workspace.indexOf('\n  }', handlerStart))
    expect(handler).toContain('if (event.nativeEvent.isComposing) return')
    expect(handler).toContain('settingsSearchKeyIntent(event.key, activeHit !== null)')
    expect(handler).toContain('nextSettingsFieldIndex(current, fieldHits.length, intent)')
    expect(handler).toContain('takeFieldHit(activeHit)')
    // Escape 不在这段里：它归页面级作用域（下一个用例钉住它的效果）。
    expect(handler).not.toContain('Escape')
  })

  it('runs 键入 → 方向键 → 回车 all the way onto the field row', () => {
    // 用户只知道字段叫什么、不知道它在哪一页：输入标签词，回车应该把光标放到那一行上。
    const hits = searchSettingsFields('关闭窗口', { runtime: null })
    expect(hits.map((hit) => hit.id)).toEqual(['application.close-policy'])
    const target = hits[0]!
    expect(target.page, '落地要翻到字段所在的页面').not.toBe('home')

    // 第一下 ↓ 从输入框落进第一条；环落在某条结果上之后，回车才是「取用它」。
    let index = -1
    const intent = settingsSearchKeyIntent('ArrowDown', false)
    expect(intent).toBe('next')
    index = nextSettingsFieldIndex(index, hits.length, 'next')
    expect(index).toBe(0)
    expect(settingsSearchKeyIntent('Enter', index >= 0)).toBe('take')
    expect(hits[index]!.id).toBe(target.id)

    // 回车之后控件做的那件事：把光标放到带 `data-settings-field` 的那一行上。
    const doc = new FakeDocument()
    const row = doc.add(new FakeRow(doc, target.id, true))
    const landing = revealSettingsField(target.id, doc.asDocument())

    expect(landing).toEqual({ id: target.id, revealed: [], focus: 'control' })
    expect(doc.activeElement).toBe(row.control)
    expect(doc.activeElement, '光标就在字段自己的控件上').toBe(row.control)
    expect(row.scrolls).toEqual([{ block: 'center', inline: 'nearest' }])
    expect(row.attributes.get(SETTINGS_FIELD_LANDED_ATTRIBUTE), '落地强调是可读的').toBe('true')
    // 强调有上限：到点自己撤掉，不会永久留在页面上。
    expect(doc.timeouts.map((entry) => entry.ms)).toEqual([SETTINGS_FIELD_LANDED_MS])
    doc.timeouts[0]!.handler()
    expect(row.attributes.has(SETTINGS_FIELD_LANDED_ATTRIBUTE)).toBe(false)
  })

  it('walks the result ring with the arrow keys and hands Enter only a visible row', () => {
    const hits = searchSettingsFields('缓存', { runtime: null })
    expect(hits.length).toBe(3)

    // ↓ 从输入框进第一条，然后逐条前进、到底回卷。
    expect(nextSettingsFieldIndex(-1, hits.length, 'next')).toBe(0)
    expect(nextSettingsFieldIndex(0, hits.length, 'next')).toBe(1)
    expect(nextSettingsFieldIndex(1, hits.length, 'next')).toBe(2)
    expect(nextSettingsFieldIndex(2, hits.length, 'next')).toBe(0)
    // ↑ 从输入框直接到最后一条（普通组合框的约定），之后逐条后退。
    expect(nextSettingsFieldIndex(-1, hits.length, 'previous')).toBe(2)
    expect(nextSettingsFieldIndex(2, hits.length, 'previous')).toBe(1)

    // 没有结果时没有环：方向键不被吞掉，回车也不落地。
    expect(nextSettingsFieldIndex(-1, 0, 'next')).toBe(-1)
    expect(nextSettingsFieldIndex(-1, 0, 'previous')).toBe(-1)
    expect(settingsSearchKeyIntent('Enter', false)).toBe('none')

    // 环上的下标永远指向真实存在的一条结果。
    for (const count of [1, 2, 3, 23]) {
      for (const intent of ['next', 'previous'] as const) {
        let cursor = -1
        for (let step = 0; step < count * 2 + 1; step += 1) {
          cursor = nextSettingsFieldIndex(cursor, count, intent)
          expect(cursor, `${intent} on ${count}`).toBeGreaterThanOrEqual(0)
          expect(cursor, `${intent} on ${count}`).toBeLessThan(count)
        }
      }
    }
  })

  it('gives Escape the single topmost scope and nothing else to do', async () => {
    const workspace = await workspaceSource()
    const open = workspace.indexOf('useEscapeScope((')
    expect(open, 'the search list takes Escape through the shared scope').toBeGreaterThanOrEqual(0)
    const body = workspace.slice(open, workspace.indexOf('}, fieldResultsVisible)', open))
    expect(body).toContain('setFieldResultsDismissed(true)')
    expect(body).toContain('setActiveFieldIndex(-1)')
    expect(body).toContain('searchInputRef.current?.focus(')
    // 「无副作用」：Escape 不清查询、不翻页、不关设置、不落地。
    for (const sideEffect of ['setSettingsQuery(', 'onOpenPage(', 'onCloseSettings(', 'takeFieldHit(']) {
      expect(body, `Escape 不做 ${sideEffect}`).not.toContain(sideEffect)
    }
    // 只有最上层能应答：列表关着时这个作用域不注册，`<input type="search">` 的原生清除行为保留。
    expect(workspace).toContain('}, fieldResultsVisible)')
    expect(workspace).not.toContain('useModalSurface')
  })

  it('scrolls the roving row into the sidebar viewport instead of leaving it off screen', async () => {
    const workspace = await workspaceSource()
    // 结果列表住在 `.settings-nav-section` 里，而它是滚动视口：索引最多 23 条，不滚动的话
    // `aria-activedescendant` 可以指到一条用户看不见的结果上。
    const styles = await readFile(new URL('../styles/07-overlays-settings.css', import.meta.url), 'utf8')
    const sectionStart = styles.indexOf('.settings-nav-section {')
    expect(sectionStart, '.settings-nav-section is the results viewport').toBeGreaterThanOrEqual(0)
    expect(styles.slice(sectionStart, styles.indexOf('\n}', sectionStart))).toContain('overflow-y: auto')

    expect(workspace).toContain('document.getElementById(settingsFieldOptionId(activeHitIndex))')
    expect(workspace).toContain("scrollIntoView({ block: 'nearest' })")
    // 只在环真的落在某条结果上时滚，并且跟着下标变化重新滚。
    expect(workspace).toContain('if (activeHitIndex < 0) return')
    expect(workspace).toMatch(/\}, \[activeHitIndex\]\)/u)
  })

  it('reveals a collapsed section and still focuses a row that has no control of its own', () => {
    // `agent.compression-threshold` 收在“高级上下文设置”的 `<details>` 里：不展开就既不可见也不可聚焦。
    const folded = new FakeDocument()
    const foldedRow = folded.add(new FakeRow(folded, 'agent.compression-threshold', true))
    const details = new FakeDetailsElement()
    foldedRow.parentElement = details
    expect(revealSettingsField('agent.compression-threshold', folded.asDocument()))
      .toEqual({ id: 'agent.compression-threshold', revealed: ['details'], focus: 'control' })
    expect(details.open).toBe(true)

    // 动作行（清理缓存、清除网站数据）没有可聚焦控件：行自己接受焦点，光标不会掉回文档。
    const action = new FakeDocument()
    const actionRow = action.add(new FakeRow(action, 'browser.clear-data', false))
    expect(revealSettingsField('browser.clear-data', action.asDocument()))
      .toEqual({ id: 'browser.clear-data', revealed: [], focus: 'row' })
    expect(action.activeElement).toBe(actionRow)
    expect(actionRow.tabIndex).toBe(-1)

    // 字段不在页面上（例如还没渲染完）：如实返回 null，不假装落地成功。
    expect(revealSettingsField('web.enabled', new FakeDocument().asDocument())).toBeNull()
  })
})
