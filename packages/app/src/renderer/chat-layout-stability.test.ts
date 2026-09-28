import { readFile } from 'node:fs/promises'
import { readRendererStyleSource, readRendererStyleSourceFiles } from './style-source-test-utils'
import { loadWindowChromeContractSources, windowChromeContractViolations } from '../../../../scripts/lib/window-chrome-contract.mjs'
import { describe, expect, it } from 'vitest'


async function readRendererFile(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

function ruleBody(styles: string, selector: string): string {
  const start = styles.indexOf(`${selector} {`)
  expect(start, `${selector} rule should exist`).toBeGreaterThanOrEqual(0)
  const end = styles.indexOf('\n}', start)
  expect(end, `${selector} rule should close`).toBeGreaterThan(start)
  return styles.slice(start, end)
}

function directRuleBody(styles: string, selector: string): string {
  const start = styles.indexOf(`\n${selector} {`)
  expect(start, `${selector} direct rule should exist`).toBeGreaterThanOrEqual(0)
  const end = styles.indexOf('\n}', start)
  expect(end, `${selector} direct rule should close`).toBeGreaterThan(start)
  return styles.slice(start + 1, end)
}

interface TransitionClock {
  property: string
  duration: string
  easing: string
}

/**
 * The rule the cascade actually leaves in charge of a selector's transition: the
 * *last* direct `selector { … }` block in the source.
 *
 * `directRuleBody` above takes the first, which is what a "this rule exists"
 * assertion wants. A question about timing wants the winner instead, and
 * `.sidebar-toggle-divider` is the case that separates them: its shared stroke
 * rule comes first, its own `transition` rule comes second.
 */
function cascadeRuleBody(source: string, selector: string): string {
  const start = source.lastIndexOf(`\n${selector} {`)
  expect(start, `${selector} direct rule should exist`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n}', start)
  expect(end, `${selector} direct rule should close`).toBeGreaterThan(start)
  return source.slice(start + 1, end)
}

/**
 * One `transition:` declaration as one entry per animated property.
 *
 * The order inside a transition item is `property duration easing ...`, so the
 * first token after the property that reads as a time (a literal `320ms` or a
 * `var(--…)` duration token) is the duration and the next one is the easing.
 * Parsing them instead of pattern-matching the raw text is what lets a test ask
 * "which clock does this property run on" rather than "does this file contain
 * the string I expect".
 */
function transitionClocks(body: string): TransitionClock[] {
  const clocks: TransitionClock[] = []
  for (const match of body.matchAll(/(?:^|\n)\s*transition:\s*([^;]+);/gu)) {
    for (const item of (match[1] ?? '').split(',')) {
      const [property, ...rest] = item.trim().split(/\s+/u).filter(Boolean)
      if (!property || rest.length === 0) continue
      const timePattern = /^(?:var\(--[\w-]+\)|[\d.]+m?s)$/u
      const duration = rest.find((token) => timePattern.test(token)) ?? ''
      const easing = rest.find((token) => token !== duration) ?? ''
      clocks.push({ property, duration, easing })
    }
  }
  return clocks
}

/** `margin-right` is animated by a `margin` item; `border-left-color` by `border-color`. */
function clockFor(clocks: TransitionClock[], property: string): TransitionClock | undefined {
  const family = /^(margin|padding)-(?:top|right|bottom|left)$/u.exec(property)
  const borderSide = /^border-(?:top|right|bottom|left)-color$/u.exec(property)
  return clocks.find((clock) => clock.property === property)
    ?? (family?.[1] ? clocks.find((clock) => clock.property === family[1]) : undefined)
    ?? (borderSide ? clocks.find((clock) => clock.property === 'border-color') : undefined)
}

/**
 * Every rule that the collapsed sidebar states switch on, and the properties
 * they switch. The selector is kept whole so the failing side can quote it.
 */
function collapsedStateRules(source: string): Array<{ selector: string; properties: string[] }> {
  const rules: Array<{ selector: string; properties: string[] }> = []
  for (const match of source.matchAll(/([^{}]*?)\{([^{}]*)\}/gu)) {
    const selector = (match[1] ?? '').trim()
    if (!selector.includes('.window-shell.sidebar-collapsed') && !selector.includes('.window-shell.sidebar-drag-collapsed')) continue
    const properties = [...(match[2] ?? '').matchAll(/(?:^|;)\s*([a-z-]+)\s*:/gu)].flatMap((entry) => (entry[1] ? [entry[1]] : []))
    rules.push({ selector, properties })
  }
  return rules
}


describe('chat layout stability', () => {
  it('uses one proportional shell width rule across normal and maximized windows', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/--sidebar-width:\s*clamp\(220px,\s*21\.5625vw,\s*460px\);/u)
    expect(styles).toMatch(/--workspace-panel-width:\s*clamp\(280px,\s*28\.125vw,\s*4096px\);/u)
    expect(styles).toMatch(/--sidebar-resizer-active-color:\s*#a0a0a0;/u)
    expect(styles).not.toMatch(/@media\s*\(max-width:\s*860px\)[\s\S]*?--sidebar-width:\s*232px;/u)
  })

  it('lays the window out in the chali arrangement: full-height sidebar, top bar over chat and workspace', async () => {
    const styles = await readRendererStyleSource()
    const app = directRuleBody(styles, '.app')
    const titlebar = directRuleBody(styles, '.window-titlebar')
    const sidebar = directRuleBody(styles, '.sidebar')
    const resizer = directRuleBody(styles, '.sidebar-resizer')
    const coreWorkspace = directRuleBody(styles, '.core-workspace')
    const dragBand = directRuleBody(styles, '.window-drag-band')
    const settingsLayout = directRuleBody(styles, '.settings-layout')
    const settingsTrack = directRuleBody(styles, '.settings-sidebar-track')
    const settingsResizer = directRuleBody(styles, '.settings-sidebar-resizer')
    const settingsBody = directRuleBody(styles, '.settings-workspace-body')
    const appView = await readRendererFile('./app-shell/app-view.tsx')
    const globalTitlebar = await readRendererFile('./sidebar/global-titlebar.tsx')
    const settingsWorkspace = await readRendererFile('./settings/workspace.tsx')

    // Two rows — the 32px top bar, then the content — over three columns: the sidebar,
    // its resize seam, and the chat+workspace region.
    expect(app).toContain('grid-template-rows: var(--window-titlebar-height) minmax(0, 1fr)')
    expect(app).toContain('var(--sidebar-active-width)')
    expect(app).toContain('var(--sidebar-active-resizer-width)')
    expect(app).toContain('minmax(0, 1fr)')

    // The top bar starts where the sidebar column ends: it is row 1 of column 3 only,
    // so it never crosses the sidebar.
    expect(titlebar).toContain('grid-column: 3')
    expect(titlebar).toContain('grid-row: 1')
    // The sidebar spans both rows, which is what carries its card up to the window's
    // top edge instead of leaving it below a full-width bar.
    expect(sidebar).toContain('grid-column: 1')
    expect(sidebar).toContain('grid-row: 1 / -1')
    expect(resizer).toContain('grid-column: 2')
    expect(resizer).toContain('grid-row: 1 / -1')
    expect(coreWorkspace).toContain('grid-column: 3')
    expect(coreWorkspace).toContain('grid-row: 2')

    // The window's top edge stays one continuous drag strip. The titlebar drags the
    // chat+workspace half; this band drags the sidebar half, taking its box from the
    // same grid track the sidebar occupies so it follows resize and collapse, and
    // sitting above the sidebar resizer so the whole band is grabbable.
    expect(dragBand).toContain('grid-column: 1')
    expect(dragBand).toContain('grid-row: 1')
    expect(dragBand).toContain('-webkit-app-region: drag')
    expect(dragBand).toContain('background: transparent')
    expect(Number(dragBand.match(/z-index:\s*(\d+)/u)?.[1] ?? 0)).toBeGreaterThan(
      Number(resizer.match(/z-index:\s*(\d+)/u)?.[1] ?? 0),
    )
    expect(titlebar).toContain('-webkit-app-region: drag')
    // Both halves carry the same two mechanisms: the CSS app-region and the pointer
    // bridge to Main, which live together in the window-chrome module.
    expect(globalTitlebar).toContain('export function WindowDragRegion')
    expect(globalTitlebar).toContain('bridge.startWindowDrag({ screenX: event.screenX, screenY: event.screenY })')
    expect(appView.match(/<WindowDragRegion\b/g)?.length).toBe(1)
    expect(appView).toContain('<WindowDragRegion className="window-drag-band" />')

    // The three navigation controls are pinned to the window's own top-left corner
    // instead of the bar's left end. The bar starts at the sidebar's right edge in
    // chali, so controls laid out inside it move with every sidebar expand, collapse
    // and resize — including the sidebar toggle, which is the only way back out of a
    // collapsed sidebar. They are therefore a shell-level fixed layer, and the pinned
    // box repeats the geometry the bar already gives them when it starts at x = 0:
    // the same 32px row, the same 24px control box (`top` centers it) and the same
    // 8px inline inset.
    const navControls = directRuleBody(styles, '.app-nav-controls')
    expect(navControls).toContain('position: fixed')
    expect(navControls).toContain('top: var(--window-nav-controls-top)')
    expect(navControls).toContain('left: var(--window-nav-controls-inset)')
    expect(navControls).toContain('-webkit-app-region: no-drag')
    // The bar's own inline inset is the number the pinned inset repeats, so a change
    // to one without the other would move the controls against the layout they are
    // pinned into rather than inside it.
    expect(titlebar).toContain('padding: 0 150px 0 8px')
    expect(styles).toMatch(/--window-nav-controls-inset:\s*8px;/u)
    // 1003 is the shell's window-chrome layer — `.settings-entry-global` — which sits
    // above the panels, above the drag band and above the settings surface that owns
    // the left rail in its state. It has to clear the band (21), or the band would
    // keep the clicks; the band keeps its whole box, so the top edge stays grabbable
    // everywhere except the controls' own 80x24 island.
    expect(Number(navControls.match(/z-index:\s*(\d+)/u)?.[1] ?? 0)).toBe(1003)
    expect(Number(navControls.match(/z-index:\s*(\d+)/u)?.[1] ?? 0)).toBeGreaterThan(
      Number(dragBand.match(/z-index:\s*(\d+)/u)?.[1] ?? 0),
    )
    expect(styles).toMatch(/\.settings-entry-global\s*\{[^}]*z-index:\s*1003;/u)
    // No layout switch may re-place the pinned controls: beta changes the bar's grid
    // span and the sidebar's row, and moves nothing else.
    expect(styles).not.toMatch(/\[data-window-layout[^{]*\.app-nav-controls/u)
    expect(globalTitlebar).toContain('export function WindowNavControls')
    expect(globalTitlebar).toContain('aria-label={sidebarToggleTip}')
    expect(globalTitlebar).toContain('aria-label="返回"')
    expect(globalTitlebar).toContain('aria-label="前进"')
    // The shell-level layer is rendered before `.primary-workspace`, so a bare
    // `.sidebar-toggle-btn` query still names the window's toggle: the workspace
    // panel's corner toggle shares that class and lives inside the panels.
    expect(appView).toContain('<WindowNavControls')
    expect(appView.indexOf('<WindowNavControls')).toBeGreaterThanOrEqual(0)
    expect(appView.indexOf('<WindowNavControls')).toBeLessThan(appView.indexOf('<div className="primary-workspace">'))
    expect(appView).toContain('<GlobalTitlebar />')
    // The bar is a pure drag surface now; the controls are not its children.
    const titlebarElement = globalTitlebar.slice(
      globalTitlebar.indexOf('export function GlobalTitlebar'),
      globalTitlebar.indexOf('export function WindowNavControls'),
    )
    expect(titlebarElement).not.toContain('app-nav-controls')

    // The inert/aria-hidden boundary for the settings hand-off covers the two panels the
    // settings surface paints over — not the top bar and not the drag band, which both
    // stay usable while settings is open. The wrapper therefore has to be layout-neutral.
    expect(appView).toContain('<div className="app-panels" aria-hidden={settingsOpen}')
    expect(appView).not.toContain('<div className="app" aria-hidden={settingsOpen}')
    expect(directRuleBody(styles, '.app-panels')).toContain('display: contents')

    // The settings surface mirrors the same arrangement: full-height rail, page column
    // below the same stationary top bar, and its own drag band over the rail.
    expect(settingsLayout).toContain('grid-template-rows: var(--window-titlebar-height) minmax(0, 1fr)')
    expect(settingsTrack).toContain('grid-column: 1')
    expect(settingsTrack).toContain('grid-row: 1 / -1')
    expect(settingsResizer).toContain('grid-column: 2')
    expect(settingsResizer).toContain('grid-row: 1 / -1')
    expect(settingsBody).toContain('grid-column: 3')
    expect(settingsBody).toContain('grid-row: 2')
    expect(settingsWorkspace.match(/<WindowDragRegion\b/g)?.length).toBe(1)
    expect(settingsWorkspace).toContain('<WindowDragRegion className="window-drag-band" />')

    // The rail's first row is a real control (the settings search field), so it keeps
    // clear of the drag band instead of sitting half inside it.
    const settingsContents = directRuleBody(styles, '.settings-sidebar-contents')
    expect(settingsContents).toContain('padding-top: calc(var(--window-titlebar-height) - var(--floating-panel-inset))')
  })

  it('keeps the pinned controls inside the window\'s clickable region in every sidebar state', async () => {
    const sources = await loadWindowChromeContractSources()

    // One gate, two callers. The contract itself — which bands are draggable, which
    // controls must be clickable, and the geometry that ties them (the top-bar row, the
    // controls' island, and the hit-region hole that has to equal it) — is declared in
    // `shared/window-chrome-contracts.ts`, including the rule this test exists for: the
    // draggable region is accumulated in DOM pre-order and ignores `z-index`, so a
    // `no-drag` box only subtracts the drag boxes contributed before it and the hole has
    // to be the last box in its originating element's pre-order subtree.
    //
    // `scripts/lib/window-chrome-contract.mjs` is the single implementation of the
    // source-level half: it reads the declared numbers, evaluates the stylesheet's own
    // tokens and calc() expressions, and reports which side has to move. The native half
    // — the same contract asked of a real window through its own WM_NCHITTEST — lives in
    // `scripts/verify-window-layout.mjs`, which calls the same gate before it starts a
    // window. No source-level assertion can observe what the OS does with a press, which
    // is why this test is the fast half rather than the whole check.
    const violations = windowChromeContractViolations(sources)
    expect(violations, violations.join('\n')).toEqual([])

    // The two facts the gate reads from the stylesheet as a whole, asserted here against
    // the rules the cascade actually leaves in charge: the hole must survive every layout
    // (beta spans the top bar over the island instead of ending it at the sidebar) and it
    // must stay a hit region rather than a layer.
    const hole = directRuleBody(sources.styles, '.window-shell::after')
    expect(hole).not.toContain('display: none')
    expect(sources.windowLayout).not.toContain('.window-shell::after')
    expect(sources.styles).not.toMatch(/\.window-shell::after\s*\{[^}]*(?:background|border|box-shadow|backdrop-filter|filter):/u)

    // And the native half has to stay the same contract rather than a parallel copy of
    // it: it reads the shared gate, derives its island from the contract, and probes the
    // declared controls in all three sidebar states — mid-resize included, which is the
    // state the controls were measured unclickable in.
    const nativeGate = await readRendererFile('../../../../scripts/verify-window-layout.mjs')
    expect(nativeGate).toContain("from './lib/window-chrome-contract.mjs'")
    expect(nativeGate).toContain('windowChromeContractViolations')
    expect(nativeGate).toContain('windowChromeControlsBox')
    expect(nativeGate).toMatch(/assertChromeState\(sample, `mid-resize \+/u)
    expect(nativeGate).toContain("'pinned expanded', { topEdge: true }")
    expect(nativeGate).toContain("'pinned collapsed', { topEdge: true }")
  })

  it('uses the code-view surface for the titlebar, chat, and workspace materials', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/--workspace-code-surface:\s*#101010;/u)
    expect(styles).toMatch(/\.window-titlebar\s*\{[\s\S]*?background:\s*var\(--workspace-code-surface\);/u)
    expect(styles).toMatch(/\.chat\s*\{[\s\S]*?background:\s*var\(--workspace-code-surface\);/u)
    expect(styles).toMatch(/\.messages\s*\{[\s\S]*?background:\s*var\(--workspace-code-surface\);/u)
    expect(styles).toMatch(/--sidebar-glass-fill:\s*color-mix\(in srgb, var\(--surface\) 36%, transparent\);/u)
    expect(styles).toMatch(/\.workspace-preview-code\s*\{[\s\S]*?background:\s*var\(--workspace-code-surface\);/u)
    expect(styles).toMatch(/\.workspace-review-diff\s*\{[\s\S]*?background:\s*var\(--workspace-code-surface\);/u)
  })

  it('keeps the rendered titlebar and native caption buttons on one height contract', async () => {
    const styles = await readRendererStyleSource()
    const desktopShell = await readFile(new URL('../main/desktop-shell.ts', import.meta.url), 'utf8')
    const titlebar = ruleBody(styles, '.window-titlebar')

    expect(styles).toMatch(/--window-titlebar-height:\s*32px;/u)
    expect(titlebar).toContain('flex: 0 0 var(--window-titlebar-height)')
    expect(titlebar).toContain('height: var(--window-titlebar-height)')
    expect(titlebar).toContain('min-height: var(--window-titlebar-height)')
    expect(titlebar).toContain('max-height: var(--window-titlebar-height)')
    expect(desktopShell).toContain('export const WINDOW_TITLEBAR_HEIGHT = DESKTOP_TITLEBAR_HEIGHT')
    expect(desktopShell).toContain('height: WINDOW_TITLEBAR_HEIGHT')
  })

  it('keeps ordinary selections muted while preserving the code-copy selection color', async () => {
    const styles = await readRendererStyleSource()
    const monacoTheme = await readRendererFile('./workspace/monaco-theme.ts')
    const terminal = await readRendererFile('./workspace/terminal.tsx')

    expect(styles).toMatch(/--selection-background:\s*#333333;/u)
    expect(styles).toMatch(/--selection-background-inactive:\s*#2e2e2e;/u)
    expect(styles).toMatch(/--code-selection-background:\s*#454545;/u)
    expect(styles).toMatch(/--code-selection-background-inactive:\s*#3a3a3a;/u)
    expect(styles).toMatch(/--selection-foreground:\s*#f2f2f2;/u)
    expect(styles).toMatch(/--selection-radius:\s*3px;/u)
    expect(styles).toMatch(/::selection\s*\{[\s\S]*?background-color:\s*var\(--selection-background\);/u)
    expect(styles).toMatch(/::-moz-selection\s*\{[\s\S]*?background-color:\s*var\(--selection-background\);/u)
    expect(styles).toMatch(/\.code-block-source::selection,[\s\S]*?background-color:\s*var\(--code-selection-background\);/u)
    expect(styles).toMatch(/\.code-block-source::-moz-selection,[\s\S]*?background-color:\s*var\(--code-selection-background\);/u)
    expect(styles).toMatch(/\.workspace-terminal-shell \.xterm-selection > div\s*\{[\s\S]*?border-radius:\s*var\(--selection-radius\);/u)
    expect(monacoTheme).toContain('LITTLE_SHEEP_SELECTION_BACKGROUND')
    expect(monacoTheme).toContain("'editor.selectionBackground': LITTLE_SHEEP_SELECTION_BACKGROUND")
    expect(terminal).toContain('selectionBackground: LITTLE_SHEEP_SELECTION_BACKGROUND')
    expect(terminal).toContain('selectionForeground: LITTLE_SHEEP_SELECTION_FOREGROUND')
  })

  it('reserves symmetric scrollbar space and keeps the chat thumb visible', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.messages\s*\{[\s\S]*?scrollbar-gutter:\s*stable both-edges;/u)
    expect(styles).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*#383838;[^}]*background-clip:\s*content-box;/u)
    expect(styles).toMatch(/::-webkit-scrollbar-thumb:hover\s*\{[^}]*background:\s*#484848;[^}]*background-clip:\s*content-box;/u)
    expect(styles).not.toContain('.messages::-webkit-scrollbar-thumb')
  })

  it('keeps the chat scrollbar two pixels from the floating workspace frame', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.core-workspace\s*\{[\s\S]*?--chat-workspace-scrollbar-gap:\s*2px;/u)
    expect(styles).toMatch(/\.core-workspace:has\(> \.workspace-panel:not\(\.collapsed\):not\(\.fullscreen\)\)\s*\{[\s\S]*?--chat-workspace-scrollbar-overlap:\s*max\(/u)
    expect(styles).toMatch(/\.chat\s*\{[\s\S]*?margin-right:\s*calc\(0px - var\(--chat-workspace-scrollbar-overlap\)\);/u)
    expect(styles).toMatch(/\.composer-shell\s*\{[\s\S]*?right:\s*var\(--chat-workspace-scrollbar-overlap\);/u)
    expect(styles).toMatch(/\.messages\s*\{[\s\S]*?calc\(var\(--chat-content-gutter\) \+ var\(--chat-workspace-scrollbar-overlap\)\);/u)
  })

  it('does not turn the final message spacing into false short-content overflow', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.messages-content\s*\{[\s\S]*?min-height:\s*100%;/u)
    expect(styles).toMatch(/\.messages-content\s*>\s*:last-child\s*\{[^}]*margin-bottom:\s*0;/u)
  })

  it('does not fight disclosure height animations with per-frame anchor repairs', async () => {
    const chatView = await readRendererFile('./app-shell/chat-view.tsx')
    const scrollController = await readRendererFile('./chat/use-chat-scroll-controller.ts')

    // The disclosure guard moved with the rest of the scroll ownership; the view only wires it.
    expect(chatView).toContain('useChatScrollController(')
    expect(chatView).toContain('onClickCapture={onClickCapture}')
    expect(scrollController).toContain('const onClickCapture = useCallback')
    expect(scrollController).toContain('.agent-tool-row, .trace-toggle')
    expect(scrollController).not.toContain('.agent-reasoning-toggle')
    expect(scrollController).toContain('stickToBottomRef.current = false')
    expect(scrollController).not.toContain("kind: 'anchor'")
    expect(scrollController).not.toContain('anchor.getBoundingClientRect()')
    expect(scrollController).not.toContain('disclosureInteractionVersion')
  })

  it('anchors viewport reflow before an intermediate compressed layout can paint', async () => {
    const styles = await readRendererStyleSource()
    const chatView = await readRendererFile('./app-shell/chat-view.tsx')
    const scrollController = await readRendererFile('./chat/use-chat-scroll-controller.ts')
    const composer = await readRendererFile('./app-shell/composer-view.tsx')
    const layoutController = await readRendererFile('./workspace/use-workspace-layout-controller.ts')

    expect(styles).toMatch(/\.messages\s*\{[^}]*overflow-anchor:\s*none;/u)
    expect(chatView).toContain('useChatScrollController(')
    expect(scrollController).toContain('new ResizeObserver')
    expect(scrollController).toContain('didChatViewportResize(previous, current)')
    expect(scrollController).toContain('applyResizeRepair')
    expect(scrollController).toContain('resolveChatResizeScrollTop')
    expect(scrollController).toContain('resizeRepairRef.current ??= {')
    expect(scrollController).toContain('geometry: previous')
    expect(scrollController).toContain('CHAT_COMPOSER_OVERLAY_RESIZE_EVENT')
    expect(scrollController).toContain('handleComposerOverlayResize')
    expect(scrollController).toContain('WINDOW_RESIZE_START_EVENT')
    expect(scrollController).toContain('windowResizeGeometry')
    expect(scrollController).toContain('before the next paint')
    expect(layoutController).toContain("document.body.classList.add('is-window-resizing')")
    expect(layoutController).toContain('WINDOW_RESIZE_SETTLE_DELAY_MS')
    expect(layoutController).toContain('applyViewportLayoutVariables')
    expect(layoutController).toContain("shell.style.setProperty('--sidebar-width'")
    expect(layoutController).toContain("shell.style.setProperty('--workspace-panel-width'")
    expect(layoutController).toContain('const settledViewportWidth = window.innerWidth')
    expect(layoutController).toContain('setViewportWidth((current) => current === settledViewportWidth ? current : settledViewportWidth)')
    expect(layoutController).toMatch(/const commitResize = \(\) => \{[\s\S]*?applyViewportLayoutVariables\(nextViewportWidth\)[\s\S]*?\n    \}/u)
    expect(styles).toMatch(/body\.is-window-resizing \.window-shell,[\s\S]*?transition-duration:\s*0ms !important;/u)
    expect(composer).toContain('CHAT_COMPOSER_OVERLAY_RESIZE_EVENT')
    expect(composer).toContain('chat.dispatchEvent(new CustomEvent(CHAT_COMPOSER_OVERLAY_RESIZE_EVENT')
    expect(composer).toContain('syncComposerInputHeight(inputRef.current)')
    expect(composer).toContain('WINDOW_RESIZE_END_EVENT')
    expect(composer).toContain("!document.body.classList.contains('is-window-resizing')")
    expect(composer).not.toContain('scheduleBottomRepair')
    expect(composer).toContain('new ResizeObserver(() => updateOverlayClearance())')
  })

  it('keeps the reply surface stable while completed Agent activity can collapse', async () => {
    const styles = await readRendererStyleSource()
    const assistantTurn = await readRendererFile('./chat/assistant-turn.tsx')
    const toolRow = await readRendererFile('./chat/agent-tool-row.tsx')

    expect(assistantTurn).toContain('className="assistant-activity-flow"')
    expect(assistantTurn).toContain('className="message assistant assistant-final assistant-response-stream"')
    expect(assistantTurn).toContain('<Markdown text={message.text} />')
    expect(assistantTurn).not.toContain('Boolean(message.activityCollapsed)')
    expect(assistantTurn).not.toContain('ActivityDisclosure')
    expect(assistantTurn).toContain('className="assistant-process-trigger"')
    expect(assistantTurn).toContain('open={processOpen} className="assistant-process-content"')
    expect(toolRow).toContain('data-call-id={tool.callId}')
    expect(styles).toMatch(/\.agent-flow-row\s*\{[^}]*min-height:\s*32px;[^}]*background:\s*transparent;[^}]*border:\s*0;/u)
    // The process body folds on the shared disclosure primitive. It used to be
    // `hidden`, which snapped the whole transcript open and shut with no transition
    // at all; the panel now keeps its box in the layout at 0fr and grows into 1fr.
    expect(styles).toMatch(/\.agent-flow-disclosure\s*\{[^}]*grid-template-rows:\s*0fr;[^}]*transition:/u)
    expect(styles).toMatch(/\.agent-flow-disclosure\.open\s*\{\s*grid-template-rows:\s*1fr;/u)
    expect(styles).toMatch(/\.agent-flow-row\.is-active::after\s*\{[^}]*animation:\s*agent-flow-sweep 2\.6s ease-out infinite;/u)
    expect(styles).not.toContain('.assistant-turn-header')
    expect(styles).not.toContain('.activity-command-header')
  })

  it('matches user messages to the active workspace-tab surface without inheriting tab geometry', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.workspace-active-item:hover,[\s\S]*?\.workspace-active-item\.active\s*\{[^}]*color:\s*var\(--text\);[^}]*background:\s*var\(--workspace-tab-glass-fill\);/u)
    expect(styles).toMatch(/--composer-surface:\s*rgba\(32, 32, 32, 0\.75\);/u)
    expect(styles).toMatch(/\.composer::before\s*\{[^}]*background:\s*var\(--composer-surface\);/u)
    expect(styles).toMatch(/\.message\.user\s*\{[^}]*margin-left:\s*auto;[^}]*padding:\s*4px 8px;[^}]*color:\s*var\(--text\);[^}]*background:\s*var\(--composer-surface\);[^}]*border:\s*0;[^}]*box-shadow:\s*none;/u)
    expect(styles).toMatch(/\.message\s*\{[^}]*max-width:\s*min\(820px, 78%\);[^}]*border-radius:\s*var\(--radius-ui\);[^}]*overflow-wrap:\s*anywhere;/u)
  })

  it('keeps the workspace as a self-contained floating rounded surface while retaining its resize divider', async () => {
    const styles = await readRendererStyleSource()
    const resizer = directRuleBody(styles, '.workspace-panel-resizer')

    expect(styles).not.toMatch(/\.workspace-panel-resizer::before\s*\{/u)
    expect(styles).not.toMatch(/\.workspace-panel::before\s*\{/u)
    expect(resizer).toContain('transform: translateX(var(--floating-panel-inset));')
    expect(styles).toMatch(/body\.is-resizing-column \.window-shell\.workspace-panel-drag-live \.workspace-panel-surface::before,[\s\S]*?\.workspace-active-item\s*\{[^}]*-webkit-backdrop-filter:\s*none;[^}]*backdrop-filter:\s*none;/u)
    expect(styles).toMatch(/\.workspace-panel-resizer:hover \+ \.workspace-panel \.workspace-panel-surface/u)
    expect(styles).toMatch(/\.workspace-panel-resizer:focus-visible \+ \.workspace-panel \.workspace-panel-surface/u)
    expect(styles).toMatch(/\.workspace-panel-resizer:hover \+ \.workspace-panel \.workspace-panel-surface,[\s\S]*?body\.is-resizing-column \.window-shell\.workspace-panel-drag-live:not\(\.workspace-panel-drag-collapsed\):not\(\.workspace-panel-drag-fullscreen\) \.workspace-panel \.workspace-panel-surface\s*\{[^}]*--floating-panel-frame-color:\s*var\(--floating-panel-resize-border\);/u)
    expect(styles).toMatch(/\.workspace-panel\s*\{[^}]*box-sizing:\s*border-box;[^}]*align-self:\s*stretch;[^}]*overflow:\s*visible;[^}]*transition:\s*flex-basis var\(--workspace-panel-motion\) var\(--motion-ease\);/u)
    expect(styles).toMatch(/\.workspace-panel-surface\s*\{[^}]*right:\s*var\(--floating-panel-inset\);[^}]*width:\s*var\(--workspace-panel-surface-width,\s*var\(--workspace-panel-width\)\);[^}]*background:\s*transparent;[^}]*background-clip:\s*border-box;[^}]*border:\s*var\(--floating-panel-border-width\) solid var\(--floating-panel-frame-color\);[^}]*border-radius:\s*var\(--radius-floating-panel\);[^}]*box-shadow:\s*var\(--floating-panel-shadow\);[^}]*transform:\s*translateX\(var\(--workspace-panel-surface-translate-x\)\);/u)
    expect(styles).toMatch(/\.workspace-panel-contents\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%;[^}]*height:\s*100%;/u)
    expect(styles).toMatch(/\.workspace-panel-surface\s*\{[^}]*background:\s*transparent;/u)
    expect(styles).not.toMatch(/\.workspace-panel-surface\s*\{[^}]*background:\s*var\(--surface\);/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-fullscreen \.workspace-panel,\s*\.window-shell\.workspace-panel-drag-fullscreen \.workspace-panel\s*\{[^}]*flex-basis:\s*100%;/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-fullscreen \.workspace-panel-surface,\s*\.window-shell\.workspace-panel-drag-fullscreen \.workspace-panel-surface\s*\{[^}]*width:\s*calc\(100% - var\(--floating-panel-inline-gutter\)\);/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-collapsed \.workspace-panel,\s*\.window-shell\.workspace-panel-drag-collapsed \.workspace-panel\s*\{[^}]*flex-basis:\s*0;/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-collapsed,\s*\.window-shell\.workspace-panel-drag-collapsed\s*\{[^}]*--workspace-panel-surface-translate-x:\s*calc\(\s*var\(--workspace-panel-surface-width,\s*var\(--workspace-panel-width\)\)\s*\+\s*var\(--floating-panel-inset\)\s*\);/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-collapsed \.workspace-panel-surface,\s*\.window-shell\.workspace-panel-drag-collapsed \.workspace-panel-surface\s*\{[^}]*pointer-events:\s*none;[^}]*border-color:\s*transparent;[^}]*box-shadow:\s*none;/u)
  })

  it('renders the sidebar and workspace as independent floating rounded rectangles', async () => {
    const styles = await readRendererStyleSource()
    const settingsWorkspace = await readRendererFile('./settings/workspace.tsx')

    expect(styles).toMatch(/--sidebar-resizer-width:\s*0px;/u)
    expect(styles).toMatch(/--floating-panel-inset:\s*8px;/u)
    expect(styles).toMatch(/--floating-panel-inline-gutter:\s*16px;/u)
    expect(styles).toMatch(/--floating-panel-border-width:\s*1px;/u)
    expect(styles).toMatch(/--floating-panel-border:\s*color-mix\(in srgb, var\(--text\) 8%, transparent\);/u)
    expect(styles).toMatch(/--floating-panel-resize-border:\s*color-mix\(in srgb, var\(--text\) 18%, transparent\);/u)
    expect(styles).toMatch(/--radius-floating-panel:\s*14px;/u)
    expect(styles).toMatch(/\.window-shell\s*\{[^}]*box-sizing:\s*border-box;[^}]*background:\s*transparent;[^}]*overflow:\s*hidden;/u)
    expect(styles).not.toMatch(/\.window-shell\s*\{[^}]*border(?:-radius)?:/u)
    expect(styles).toMatch(/\.window-titlebar\s*\{[^}]*background:\s*var\(--workspace-code-surface\);[^}]*border-bottom:\s*0;/u)
    expect(styles).not.toMatch(/\.sidebar-resizer::before\s*\{/u)
    // Beta owns one shared chrome material rather than one per panel.
    expect(ruleBody(styles, "html[data-window-layout='beta'] .window-shell::before")).toContain('inset: 0')
    // The shell generates exactly two boxes: `::before` is that one chrome material, and
    // `::after` is the pinned controls' no-drag hole. The hole is a hit region, not a
    // layer — it must keep painting nothing at all, which is what this line forbids.
    expect(styles).not.toMatch(/\.window-shell::after\s*\{[^}]*(?:background|border|box-shadow|backdrop-filter|filter):/u)
    expect(styles).not.toMatch(/\.primary-workspace::before\s*\{/u)
    expect(styles).not.toMatch(/\.window-titlebar::before\s*\{/u)
    expect(styles).toMatch(/\.sidebar::before,\s*\.settings-sidebar-track::before\s*\{[\s\S]*?linear-gradient\(var\(--workspace-code-surface\),\s*var\(--workspace-code-surface\)\)[\s\S]*?radial-gradient[\s\S]*?var\(--radius-floating-panel\)/u)
    expect(styles).not.toMatch(/\.sidebar::before,\s*\.settings-sidebar-track::before\s*\{[^}]*border-radius:/u)
    expect(styles).not.toMatch(/\.settings-sidebar::before\s*\{/u)
    expect(styles).not.toMatch(/\.primary-workspace::after\s*\{/u)
    expect(styles).not.toMatch(/\.settings-sidebar-resizer::before\s*\{/u)
    expect(styles).toMatch(/\.sidebar-resizer\s*\{[^}]*width:\s*8px;[^}]*margin-left:\s*calc\(-4px - var\(--floating-panel-inset\)\);[^}]*margin-right:\s*calc\(var\(--floating-panel-inset\) - 4px\);/u)
    expect(styles).toMatch(/\.settings-sidebar-resizer\s*\{[^}]*width:\s*8px;[^}]*margin-left:\s*calc\(-4px - var\(--floating-panel-inset\)\);[^}]*margin-right:\s*calc\(var\(--floating-panel-inset\) - 4px\);/u)
    expect(styles).toMatch(/\.sidebar\s*\{[^}]*position:\s*relative;[^}]*background:\s*transparent;[^}]*overflow:\s*visible;/u)
    expect(styles).toMatch(/\.sidebar-surface\s*\{[^}]*left:\s*var\(--floating-panel-inset\);[^}]*width:\s*var\(--sidebar-surface-width,\s*var\(--sidebar-width\)\);[^}]*overflow:\s*hidden;[^}]*background:\s*transparent;[^}]*background-clip:\s*border-box;[^}]*border:\s*var\(--floating-panel-border-width\) solid var\(--floating-panel-frame-color\);[^}]*border-radius:\s*var\(--radius-floating-panel\);[^}]*box-shadow:\s*var\(--floating-panel-shadow\);[^}]*transform:\s*translateX\(var\(--sidebar-surface-translate-x\)\);/u)
    expect(styles).toMatch(/\.settings-sidebar-track\s*\{[^}]*position:\s*relative;[^}]*background:\s*transparent;[^}]*overflow:\s*visible;/u)
    expect(settingsWorkspace).toContain('className="sidebar-surface settings-sidebar"')
    expect(styles).not.toMatch(/\.settings-sidebar\s*\{[^}]*border:\s*var\(--floating-panel-border-width\)/u)
    expect(styles).toMatch(/\.workspace-panel-surface\s*\{[^}]*background:\s*transparent;[^}]*background-clip:\s*border-box;[^}]*border:\s*var\(--floating-panel-border-width\) solid var\(--floating-panel-frame-color\);[^}]*border-radius:\s*var\(--radius-floating-panel\);[^}]*box-shadow:\s*var\(--floating-panel-shadow\);/u)
    // The material layer is clipped by its own `border-radius`, not by a
    // `clip-path`: an inset `round` clip draws arcs only, so it cut the blur to
    // a round corner while the frame's border and shadow followed the
    // superellipse, and the mismatch left an unpainted sliver at each corner.
    // `12-squircle-corners.css` gives this layer the frame's corner shape and
    // records the Chromium 152 measurement behind that change.
    expect(styles).toMatch(/\.sidebar-surface::before,\s*\.workspace-panel-surface::before\s*\{[^}]*inset:\s*0;[^}]*border-radius:\s*var\(--floating-panel-inner-radius\);[^}]*background:\s*var\(--sidebar-glass-fill\);[^}]*-webkit-backdrop-filter:\s*blur\(20px\) saturate\(145%\);[^}]*backdrop-filter:\s*blur\(20px\) saturate\(145%\);/u)
    expect(styles).not.toMatch(/\.sidebar-surface::after,\s*\.workspace-panel-surface::after,\s*\.settings-sidebar::after\s*\{/u)
    expect(styles).toMatch(/\.primary-workspace:has\(\.sidebar-resizer:hover\) \.sidebar-surface/u)
    expect(styles).toMatch(/\.settings-layout:has\(\.settings-sidebar-resizer:hover\) \.settings-sidebar/u)
    expect(styles).toMatch(/\.primary-workspace:has\(\.sidebar-resizer:hover\) \.sidebar-surface,[\s\S]*?body\.is-resizing-column \.window-shell\.sidebar-drag-live \.settings-sidebar\s*\{[^}]*--floating-panel-frame-color:\s*var\(--floating-panel-resize-border\);/u)
  })

  it('keeps the composer above messages with dynamic clearance and glass material', async () => {
    const styles = await readRendererStyleSource()
    const composer = await readRendererFile('./app-shell/composer-view.tsx')

    expect(styles).toMatch(/\.chat\s*\{[\s\S]*?--composer-max-width:\s*740px;[\s\S]*?--chat-content-max-width:\s*var\(--composer-max-width\);/u)
    expect(styles).toMatch(/\.composer\s*\{[\s\S]*?width:\s*min\(var\(--composer-max-width\), 100%\);/u)
    expect(styles).toMatch(/--composer-overlay-height:\s*116px;/u)
    expect(styles).toMatch(/\.messages\s*\{[\s\S]*?calc\(var\(--composer-overlay-height\) \+ var\(--composer-message-gap\)\)[\s\S]*?calc\(var\(--chat-content-gutter\) \+ var\(--chat-workspace-scrollbar-overlap\)\);[\s\S]*?scroll-padding-bottom:[\s\S]*?var\(--composer-overlay-height\)/u)
    expect(styles).toMatch(/\.composer-shell\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;[\s\S]*?z-index:\s*40;[\s\S]*?pointer-events:\s*none;/u)
    // The glass material lives on an inset ::before, not on the element: an
    // element that carries a backdrop-filter is the backdrop root for every
    // popover it opens, and a descendant blur only samples what that root
    // already painted, so the add menu and the model/permission picker lost
    // their frost (Chromium 152: ~60/255 stripe step against ~1/255) until the
    // material moved to a layer the popovers are not nested inside.
    expect(styles).toMatch(/\.composer\s*\{[^}]*background:\s*transparent;/u)
    expect(styles).not.toMatch(/\.composer\s*\{[^}]*backdrop-filter:/u)
    expect(styles).toMatch(/\.composer::before\s*\{[^}]*background:\s*var\(--composer-surface\);[^}]*-webkit-backdrop-filter:\s*blur\(18px\) saturate\(135%\);[^}]*backdrop-filter:\s*blur\(18px\) saturate\(135%\);/u)
    expect(styles).toMatch(/\.composer\s*\{[^}]*border:\s*0;/u)
    expect(styles).not.toMatch(/\.composer\.drag-active\s*\{[^}]*border-color:/u)
    expect(composer).toContain('useLayoutEffect')
    expect(composer).toContain('ResizeObserver')
    expect(composer).toContain('--composer-overlay-height')
  })

  it('keeps both sidebar variants as translucent acrylic material over their own floating surfaces', async () => {
    const styles = await readRendererStyleSource()
    const desktopShell = await readRendererFile('../main/desktop-shell.ts')
    expect(styles).toMatch(/--bg:\s*#141414;/u)
    expect(styles).toMatch(/--workspace-code-surface:\s*#101010;/u)
    expect(styles).toMatch(/--sidebar-glass-fill:\s*color-mix\(in srgb, var\(--surface\) 36%, transparent\);/u)
    expect(styles).not.toContain('sidebar-wash-dithered')
    expect(styles).toMatch(/--floating-panel-inner-radius:\s*calc\(\s*var\(--radius-floating-panel\) - var\(--floating-panel-border-width\)\s*\);/u)
    for (const selector of ['.sidebar-surface']) {
      const surface = directRuleBody(styles, selector)
      expect(surface).toContain('background: transparent')
      expect(surface).toContain('background-clip: border-box')
      expect(surface).toContain('border: var(--floating-panel-border-width) solid var(--floating-panel-frame-color)')
      expect(surface).toContain('border-radius: var(--radius-floating-panel)')
      expect(surface).toContain('box-shadow: var(--floating-panel-shadow)')
      expect(surface).not.toContain('-webkit-backdrop-filter')
      expect(surface).not.toContain('backdrop-filter')
      expect(surface).not.toContain('background-image')
      expect(surface).not.toContain('0 0 0 var(--floating-panel-border-width)')
    }
    const materialRuleStart = styles.indexOf('.sidebar-surface::before,')
    const materialRule = styles.slice(materialRuleStart, styles.indexOf('\n}', materialRuleStart))
    expect(materialRule).toContain('background: var(--sidebar-glass-fill)')
    expect(materialRule).toContain('-webkit-backdrop-filter: blur(20px) saturate(145%)')
    expect(materialRule).toContain('backdrop-filter: blur(20px) saturate(145%)')
    expect(materialRule).toContain('border-radius: var(--floating-panel-inner-radius)')
    expect(ruleBody(styles, "html[data-window-layout='beta'] .sidebar-surface::before")).toContain('background: transparent')
    expect(styles).not.toContain('.sidebar-surface::after')
    expect(styles).toMatch(/\.window-titlebar\s*\{[\s\S]*?background:\s*var\(--workspace-code-surface\);/u)
    expect(styles).not.toContain('mask-image')
    expect(styles).not.toContain('sidebar-corner-mask')
    expect(desktopShell).toContain("transparent: false")
    // Native chrome owns acrylic and follows maximize/fullscreen independently
    // of the panel controls. The standalone startup page remains opaque.
    expect(desktopShell).toContain('installDesktopWindowChrome(win,')
    expect(desktopShell).toContain('color: DESKTOP_STARTUP_SURFACE')
    expect(desktopShell).toContain('export const WINDOW_TITLEBAR_HEIGHT = DESKTOP_TITLEBAR_HEIGHT')
    expect(desktopShell).toContain('roundedCorners: true')
    expect(desktopShell).toContain('thickFrame: true')
    expect(desktopShell).toContain('win.setAccentColor(false)')
    expect(desktopShell).toContain('hasShadow: true')
    expect(desktopShell).not.toContain('transparent: true')
  })

  it('moves complete floating panels while shell geometry reflows', async () => {
    const styles = await readRendererStyleSource()
    const sidebarContents = ruleBody(styles, '.sidebar-contents')
    const workspaceContents = ruleBody(styles, '.workspace-panel-contents')

    expect(styles).not.toContain('--panel-content-hide-motion')
    expect(styles).not.toContain('--panel-content-reveal-motion')
    expect(styles).not.toContain('--panel-content-reveal-delay')
    expect(styles).toMatch(/--sidebar-surface-translate-x:\s*0px;/u)
    expect(styles).toMatch(/--workspace-panel-surface-translate-x:\s*0px;/u)
    expect(styles).toMatch(/(?:^|\n)\.sidebar\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?overflow:\s*visible;/u)
    const sidebarSurface = directRuleBody(styles, '.sidebar-surface')
    expect(sidebarSurface).toContain('position: absolute')
    expect(sidebarSurface).toContain('left: var(--floating-panel-inset)')
    expect(sidebarSurface).toContain('width: var(--sidebar-surface-width, var(--sidebar-width))')
    expect(sidebarSurface).toContain('transform: translateX(var(--sidebar-surface-translate-x))')
    expect(sidebarSurface).toContain('transform var(--sidebar-collapse-motion) var(--motion-ease)')
    expect(sidebarContents).toContain('visibility: visible')
    expect(sidebarContents).not.toContain('transition:')
    expect(styles).toMatch(/\.window-shell\.sidebar-collapsed,\s*\.window-shell\.sidebar-drag-collapsed\s*\{[^}]*--sidebar-surface-translate-x:\s*calc\(\s*-1\s*\*\s*\(var\(--sidebar-surface-width,\s*var\(--sidebar-width\)\)\s*\+\s*var\(--floating-panel-inset\)\s*\)\s*\);/u)
    expect(styles).toMatch(/\.window-shell\.sidebar-collapsed \.sidebar-surface,\s*\.window-shell\.sidebar-drag-collapsed \.sidebar-surface\s*\{[^}]*pointer-events:\s*none;[^}]*border-color:\s*transparent;[^}]*box-shadow:\s*none;/u)
    expect(styles).toMatch(/\.window-shell\.sidebar-collapse-settling \.sidebar-surface\s*\{[^}]*transition:[\s\S]*?transform var\(--sidebar-collapse-motion\)/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-collapse-settling \.workspace-panel-surface\s*\{[^}]*transition:[\s\S]*?transform var\(--workspace-panel-motion\)/u)
    expect(styles).toMatch(/\.window-shell\.sidebar-collapse-handoff \.sidebar-surface,\s*\.window-shell\.workspace-panel-collapse-handoff \.workspace-panel-surface\s*\{[^}]*transition:\s*none;/u)
    const collapsedSidebarContents = directRuleBody(styles, '.window-shell.sidebar-collapsed .sidebar-contents,\n.window-shell.sidebar-drag-collapsed .sidebar-contents')
    expect(collapsedSidebarContents).not.toContain('opacity:')
    expect(collapsedSidebarContents).not.toContain('visibility:')
    expect(styles).toMatch(/(?:^|\n)\.workspace-panel\s*\{[\s\S]*?flex:\s*0 0 calc\(var\(--workspace-panel-active-width\) \+ var\(--floating-panel-inline-gutter\)\);[\s\S]*?overflow:\s*visible;/u)
    const workspaceSurface = directRuleBody(styles, '.workspace-panel-surface')
    expect(workspaceSurface).toContain('position: absolute')
    expect(workspaceSurface).toContain('right: var(--floating-panel-inset)')
    expect(workspaceSurface).toContain('width: var(--workspace-panel-surface-width, var(--workspace-panel-width))')
    expect(workspaceSurface).toContain('transform: translateX(var(--workspace-panel-surface-translate-x))')
    expect(workspaceSurface).toContain('transform var(--workspace-panel-motion) var(--motion-ease)')
    expect(workspaceContents).toContain('content-visibility: visible')
    expect(workspaceContents).not.toContain('transition:')
    expect(styles).toMatch(/\.window-shell\.workspace-panel-collapsed,\s*\.window-shell\.workspace-panel-drag-collapsed\s*\{[^}]*--workspace-panel-surface-translate-x:\s*calc\(\s*var\(--workspace-panel-surface-width,\s*var\(--workspace-panel-width\)\)\s*\+\s*var\(--floating-panel-inset\)\s*\);/u)
    const collapsedWorkspaceContents = directRuleBody(styles, '.window-shell.workspace-panel-collapsed .workspace-panel-contents,\n.window-shell.workspace-panel-drag-collapsed .workspace-panel-contents')
    expect(collapsedWorkspaceContents).not.toContain('content-visibility: hidden')
    expect(collapsedWorkspaceContents).not.toContain('opacity:')
  })

  /**
   * One sidebar collapse is one clock.
   *
   * Measured in the real window on 2026-09-28 (1280x823, Chromium 152, the
   * chali layout, per-frame sampling of every layer through one collapse and one
   * expand): the grid track that carries the chat column, the card, the drag
   * band's box, the contents rail, the footer and the toggle's divider were all
   * on `--sidebar-collapse-motion` — every one of them crossed 50% of its own
   * travel at the same instant, 51.4ms after the click. Two layers were not:
   * the card's frame (`box-shadow`), which in chali is the card's only painted
   * edge, and the resize seam's `opacity`. Both read `--motion-fast`, the 140ms
   * hover-feedback clock, so they crossed 50% at 31.3ms — 20.1ms early, 39% of
   * the way through the collapse — and were finished at 87.6ms while the card
   * still had 180.5ms of travel left. That is the report: one layer starts and
   * finishes before another.
   *
   * The assertion is over the stylesheet rather than over pixels because the
   * real-window half lives in `scripts/verify-window-layout.mjs`, which is owned
   * by the window-chrome work. What this can prove cheaply and exactly is the
   * invariant the defect violated: every property a collapsed sidebar state
   * switches, on a layer that transitions it, reads the same duration and easing
   * token as the motion it belongs to.
   *
   * The settings rail (`styles/07-overlays-settings.css`) mirrors these rules on
   * the same tokens and is deliberately out of scope here: it is a separate
   * surface with its own owner, and its resizer still fades on `--motion-fast`.
   */
  it('drives every layer of one sidebar collapse from a single motion clock', async () => {
    const files = await readRendererStyleSourceFiles()
    const sidebarFile = files.find((file) => file.path === './styles/03-shell-sidebar.css')
    expect(sidebarFile, 'the sidebar stylesheet must stay in the renderer style manifest').toBeDefined()
    const sidebar = sidebarFile?.source ?? ''

    // The clock itself: one duration token and one easing token, and the same
    // 320ms number on the JS side, which schedules the durable-width handoff off
    // a timestamp instead of off `transitionend`.
    expect(sidebar).toMatch(/--sidebar-collapse-motion:\s*var\(--two-stage-resize-motion\);/u)
    expect(sidebar).toMatch(/--two-stage-resize-motion:\s*320ms;/u)
    expect(sidebar).toMatch(/--motion-ease:\s*cubic-bezier\(0\.2, 0\.8, 0\.2, 1\);/u)
    const preferences = await readRendererFile('./app-shell/preferences.ts')
    expect(preferences).toContain('export const TWO_STAGE_RESIZE_MOTION_MS = 320')
    expect(preferences).toContain('export const SIDEBAR_SETTLE_ANIMATION_MS = TWO_STAGE_RESIZE_MOTION_MS')

    // The layers that have to read that clock, named explicitly. A new one is a
    // deliberate addition to the collapse, not something that can appear quietly.
    const participants: Array<[string, string]> = [
      ['.app', 'grid-template-columns'],
      ['.sidebar-surface', 'transform'],
      ['.sidebar-surface', 'border-color'],
      ['.sidebar-surface', 'box-shadow'],
      ['.sidebar-resizer', 'width'],
      ['.sidebar-resizer', 'margin'],
      ['.sidebar-resizer', 'opacity'],
      ['.settings-entry-btn', 'transform'],
      ['.settings-entry-btn', 'opacity'],
      ['.sidebar-toggle-divider', 'transform'],
    ]
    for (const [selector, property] of participants) {
      const clock = clockFor(transitionClocks(cascadeRuleBody(sidebar, selector)), property)
      expect(clock, `${selector} declares no transition for ${property}`).toBeDefined()
      expect(clock?.duration, `${selector} ${property} is not on the collapse clock`).toBe('var(--sidebar-collapse-motion)')
      expect(clock?.easing, `${selector} ${property} does not share the collapse easing`).toBe('var(--motion-ease)')
    }

    // Which rule owns a layer's transition, so a collapsed-state rule can be
    // resolved to the declaration that actually animates it. `.sidebar` and
    // `.sidebar-contents` are registered with no transition of their own: only
    // their `pointer-events` change, and the card carries them.
    const clockOwners: Record<string, string> = {
      '.app': '.app',
      '.sidebar-surface': '.sidebar-surface',
      '.sidebar-resizer': '.sidebar-resizer',
      '.settings-entry-global': '.settings-entry-btn',
      '.sidebar-toggle-divider': '.sidebar-toggle-divider',
      '.sidebar': '.sidebar',
      '.sidebar-contents': '.sidebar-contents',
    }

    let checked = 0
    for (const rule of collapsedStateRules(sidebar)) {
      for (const part of rule.selector.split(',')) {
        const layer = part.trim().replace(/^\.window-shell\.sidebar-(?:drag-)?collapsed\s+/u, '')
        if (!layer || layer === part.trim()) continue
        expect(Object.keys(clockOwners), `${layer} joins the collapse without a registered clock owner`).toContain(layer)
        const owner = clockOwners[layer] ?? layer
        const clocks = transitionClocks(cascadeRuleBody(sidebar, owner))
        for (const property of rule.properties) {
          const clock = clockFor(clocks, property)
          if (!clock) continue
          expect(clock.duration, `${layer} ${property} animates on ${clock.duration}, not on the collapse clock`).toBe('var(--sidebar-collapse-motion)')
          expect(clock.easing, `${layer} ${property} eases on ${clock.easing}`).toBe('var(--motion-ease)')
          checked += 1
        }
      }
    }
    // Not vacuous: the scan really resolved the layers that used to disagree.
    expect(checked).toBeGreaterThanOrEqual(6)

    // A transition re-declared for the drag collapse is either the same clock or
    // the deliberate `transition: none` that commits the saved width while the
    // card is already outside the chat viewport.
    for (const match of sidebar.matchAll(/([^{}]*?)\{([^{}]*)\}/gu)) {
      const selector = (match[1] ?? '').trim()
      const body = match[2] ?? ''
      if (!selector.includes('.sidebar-collapse-settling') && !selector.includes('.sidebar-collapse-handoff')) continue
      if (/transition:\s*none;/u.test(body)) continue
      for (const clock of transitionClocks(body)) {
        expect(clock.duration, `${selector} [${clock.property}]`).toBe('var(--sidebar-collapse-motion)')
        expect(clock.easing, `${selector} [${clock.property}]`).toBe('var(--motion-ease)')
      }
    }
  })

  it('keeps drag collapse continuous through pointer release and the durable handoff', async () => {
    const sidebarResize = await readRendererFile('./sidebar/resize-interaction.ts')
    const workspaceResize = await readRendererFile('./workspace/resize-interaction.ts')

    expect(sidebarResize).toContain("flushSync(() => setSidebarCollapsed(true))")
    expect(sidebarResize).toContain("shell.classList.add('sidebar-collapse-settling')")
    expect(sidebarResize).toContain("currentShell.classList.add('sidebar-collapse-handoff')")
    expect(sidebarResize).toContain("'--sidebar-surface-width'")
    expect(sidebarResize).toContain('void currentShell.offsetWidth')
    expect(sidebarResize).toContain('(upEvent as PointerEvent).clientX')
    expect(workspaceResize).toContain("shell.classList.add('workspace-panel-collapse-settling')")
    expect(workspaceResize).toContain("currentShell.classList.add('workspace-panel-collapse-handoff')")
    expect(workspaceResize).toContain("'--workspace-panel-surface-width'")
    expect(workspaceResize).toContain('void currentShell.offsetWidth')
    expect(workspaceResize).toContain('(upEvent as PointerEvent).clientX')
  })

  it('waits for the renderer before restoring a maximized window and showing it', async () => {
    const desktopShell = await readRendererFile('../main/desktop-shell.ts')

    expect(desktopShell).toContain('const shouldRestoreMaximized = restoredState?.maximized === true')
    expect(desktopShell).toContain('let rendererReadyForInitialShow = false')
    expect(desktopShell).toContain('let restoredWindowStateReady = !shouldRestoreMaximized')
    expect(desktopShell).toMatch(/rendererReadyForInitialShow &&[\s\S]*?restoredWindowStateReady/u)
    expect(desktopShell).toMatch(/win\.once\('ready-to-show', markRendererReadyForInitialShow\)/u)
    expect(desktopShell).toMatch(/win\.webContents\.once\('did-finish-load', \(\) => \{[\s\S]*?markRendererReadyForInitialShow\(\)/u)
    expect(desktopShell).toMatch(/win\.once\('maximize', finishMaximizeRestore\)[\s\S]*?win\.maximize\(\)/u)
    expect(desktopShell).not.toMatch(/if \(restoredState\?\.maximized\) win\.maximize\(\)/u)
  })

  it('keeps answer separators as a single subdued white rule', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.message \.markdown hr\s*\{[\s\S]*?height:\s*0;[\s\S]*?border:\s*0;[\s\S]*?border-top:\s*1px solid rgba\(255, 255, 255, 0\.10\);/u)
  })

  it('keeps the settings entry equally inset from the sidebar left and bottom edges', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/--sidebar-content-block-inset:\s*18px;/u)
    expect(styles).toMatch(/--sidebar-content-inline-inset:\s*14px;/u)
    expect(styles).toMatch(/--settings-entry-edge-inset:\s*3px;/u)
    expect(styles).toMatch(/--settings-entry-left:\s*calc\(var\(--floating-panel-inset\) \+ var\(--settings-entry-edge-inset\)\);/u)
    expect(styles).toMatch(/--settings-entry-bottom:\s*calc\(var\(--floating-panel-inset\) \+ var\(--settings-entry-edge-inset\)\);/u)
    expect(styles).toMatch(/--settings-entry-collapsed-width:\s*37px;/u)
    expect(styles).toMatch(/--settings-origin-x:\s*calc\(var\(--settings-entry-left\) \+ \(var\(--settings-entry-collapsed-width\) \/ 2\)\);/u)
    expect(styles).toMatch(/--settings-origin-y:\s*calc\(100vh - var\(--settings-entry-bottom\) - \(var\(--settings-entry-height\) \/ 2\)\);/u)
    // The settings surface spans the window (chali), so its local reveal origin is the
    // global anchor: the old `- 32px` undid the offset of a surface that started below
    // the title bar, and that offset no longer exists.
    expect(styles).toMatch(/--settings-content-origin-y:\s*var\(--settings-origin-y\);/u)
    expect(styles).toMatch(/--settings-entry-height:\s*34px;/u)
    expect(styles).toMatch(/\.sidebar-contents\s*\{[^}]*padding:\s*var\(--sidebar-content-block-inset\) var\(--sidebar-content-inline-inset\);/u)
    expect(styles).toMatch(/\.settings-sidebar-contents\s*\{[^}]*padding:\s*var\(--sidebar-content-block-inset\) var\(--sidebar-content-inline-inset\);/u)
    expect(styles).toMatch(/\.settings-entry-btn\s*\{[^}]*display:\s*grid;[^}]*width:\s*var\(--settings-entry-collapsed-width\);[^}]*min-width:\s*var\(--settings-entry-collapsed-width\);[^}]*height:\s*var\(--settings-entry-height\);[^}]*padding:\s*0;[^}]*border:\s*0;/u)
    expect(styles).toMatch(/\.settings-entry-global\s*\{[^}]*position:\s*fixed;[^}]*left:\s*var\(--settings-entry-left\);[^}]*bottom:\s*var\(--settings-entry-bottom\);[^}]*z-index:\s*1003;/u)
    expect(styles).not.toContain('settings-entry-bridge')
    expect(styles).not.toContain('settings-entry-label')
    expect(styles).not.toContain('settings-entry-bridge-label')
    expect(styles).not.toContain('max-width: 86px')
    expect(styles).toMatch(/\.settings-entry-btn::after\s*\{[^}]*left:\s*calc\(var\(--settings-entry-collapsed-width\) \/ 2\);/u)
  })

  it('hands off the persistent settings sidebar without painting two rails together', async () => {
    const styles = await readRendererStyleSource()

    const appView = await readRendererFile('./app-shell/app-view.tsx')
    const sidebarView = await readRendererFile('./app-shell/sidebar-view.tsx')

    expect(styles).toMatch(/\.window-shell\.settings-open \.primary-workspace \.sidebar\s*\{[^}]*pointer-events:\s*none;[^}]*transition:\s*none;/u)
    expect(styles).toMatch(/\.window-shell\.settings-open \.primary-workspace \.sidebar-resizer\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;[^}]*transition:\s*none;/u)
    expect(styles).not.toMatch(/\.window-shell\.settings-open \.primary-workspace \.sidebar::before\s*\{[^}]*visibility:\s*hidden;/u)
    expect(styles).toMatch(/\.window-shell\.settings-open \.primary-workspace \.sidebar-surface\s*\{[^}]*display:\s*none;/u)
    expect(styles).toMatch(/\.window-shell\.settings-returning \.primary-workspace \.sidebar-surface\s*\{[^}]*display:\s*flex;[^}]*animation:\s*settings-sidebar-return var\(--settings-reveal-motion\) var\(--motion-ease\) both;/u)
    expect(styles).toMatch(/\.window-shell\.settings-returning \.primary-workspace \.sidebar-contents\s*\{[^}]*animation:\s*settings-sidebar-contents-return var\(--settings-reveal-motion\) var\(--motion-ease\) both;/u)
    expect(styles).not.toMatch(/\.window-shell:has\(> \.presence-layer \.settings-workspace\) \.primary-workspace \.sidebar-contents/u)
    expect(styles).toMatch(/\.presence-layer\.presence-exiting \.settings-sidebar-track\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;[^}]*transition:\s*opacity var\(--settings-reveal-motion\) var\(--motion-ease\);/u)
    expect(styles).not.toMatch(/\.window-shell\.settings-open \.primary-workspace\s*\{[^}]*display:\s*none;/u)
    expect(styles).toMatch(/\.settings-workspace\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*visibility:\s*hidden;[^}]*transition:\s*visibility 0s linear var\(--settings-reveal-motion\);/u)
    expect(styles).toContain('.presence-layer.settings-presence.visible .settings-workspace {')
    expect(styles).toContain('visibility: visible;\n  transition: visibility 0s linear 0s;')
    expect(styles).toContain('.presence-layer.settings-presence.presence-entering .settings-workspace {')
    expect(styles).toContain('visibility: visible;\n  transition: none;')
    expect(styles).toContain('.presence-layer.settings-presence.presence-exiting:not(.presence-hidden) .settings-workspace {')
    expect(styles).not.toContain('clip-path: circle(')
    expect(styles).not.toMatch(/\.settings-workspace\s*\{[^}]*transform:/u)
    expect(styles).toMatch(/\.presence-layer\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/u)
    expect(styles).toMatch(/--settings-reveal-motion:\s*560ms;/u)
    expect(styles).toMatch(/--settings-sidebar-exit-reveal-delay:\s*80ms;/u)
    expect(styles).not.toContain('clip-path: circle(0 at var(--settings-origin-x) var(--settings-origin-y))')
    const overlaysView = await readRendererFile('./app-shell/overlays-view.tsx')
    const presence = await readRendererFile('./ui/presence.tsx')
    expect(overlaysView).toContain('exitMs={560}')
    expect(overlaysView).toContain('enterFrames={1}')
    expect(overlaysView).toContain('keepMounted')
    expect(overlaysView).toContain('onExited={finishSettingsReturn}')
    expect(overlaysView).toContain('className="settings-presence"')
    expect(presence).toContain("useState<PresencePhase>(show ? 'entering' : 'exiting')")
    expect(presence).toContain('if (!mounted && !keepMounted) return null')
    expect(presence).toContain("persistentHidden ? 'presence-hidden' : ''")
    expect(presence).toContain('onExited?: () => void')
    expect(styles).toMatch(/\.presence-layer\.settings-presence\s*\{[^}]*pointer-events:\s*none;/u)
    // The settings surface covers the whole window now, so hit testing is decided per
    // region: the surface and its grid are click-through, and the rail, the rail's
    // resize seam, the page column and the drag band take the pointer back. Without
    // this the overlay would swallow the stationary top bar's navigation controls and
    // the window's top-left drag strip.
    expect(styles).toMatch(/\.settings-workspace\s*\{[^}]*pointer-events:\s*none;/u)
    expect(styles).toMatch(/\.settings-layout\s*\{[^}]*pointer-events:\s*none;/u)
    expect(styles).toMatch(/\.settings-sidebar-track\s*\{[^}]*pointer-events:\s*auto;/u)
    expect(styles).toMatch(/\.settings-sidebar-resizer\s*\{[^}]*pointer-events:\s*auto;/u)
    expect(styles).toMatch(/\.settings-workspace-body\s*\{[^}]*pointer-events:\s*auto;/u)
    expect(styles).toMatch(/\.window-drag-band\s*\{[^}]*pointer-events:\s*auto;/u)
    expect(appView).toContain('<SettingsEntryButton')
    expect(appView).toContain('onOpen={openSettingsFromEntry}')
    expect(appView).toContain('onClose={closeSettingsFromEntry}')
    expect(sidebarView).not.toContain('settings-entry-label')
    expect(sidebarView).not.toContain('onMouseDown={() => {')
    expect(sidebarView).not.toContain('settings-entry-btn')
  })

  it('keeps the edge reveal entry and one stationary animated corner toggle above chat', async () => {
    const styles = await readRendererStyleSource()
    const dockView = await readRendererFile('./app-shell/workspace-dock-view.tsx')
    const panelView = await readRendererFile('./workspace/panel.tsx')

    expect(dockView).toContain('workspace-panel-reopen-target')
    expect(dockView).toContain('workspace-panel-corner-toggle')
    expect(dockView).toContain('className="sidebar-toggle-btn workspace-panel-corner-toggle workspace-tab-row-control"')
    expect(panelView).toContain('className="workspace-panel-actions workspace-tab-row-control"')
    expect(dockView).toContain('<SidebarToggleIcon className="workspace-panel-toggle-icon" />')
    expect(panelView).not.toContain('onToggleCollapsed')
    expect(styles).toMatch(/\.workspace-panel-reopen-target\s*\{[\s\S]*?top:\s*50%;/u)
    expect(styles).toMatch(/\.core-workspace\s*\{[^}]*--workspace-tab-row-inset:\s*4px;[^}]*--workspace-tab-row-height:\s*30px;/u)
    expect(styles).toMatch(/\.workspace-tab-row-control\s*\{[^}]*position:\s*absolute;[^}]*top:\s*var\(--workspace-tab-row-inset\);[^}]*height:\s*var\(--workspace-tab-row-height\);/u)
    expect(styles).toMatch(/\.workspace-panel-corner-toggle\s*\{[^}]*right:\s*12px;/u)
    expect(styles).toMatch(/\.workspace-panel-actions\s*\{[^}]*right:\s*calc\([\s\S]*?var\(--workspace-tab-row-height\)[\s\S]*?var\(--workspace-tab-row-gap\)/u)
    expect(styles).toMatch(/\.workspace-panel-corner-toggle\s*\{[^}]*top:\s*var\(\s*--workspace-panel-toggle-top,\s*calc\(\s*var\(--floating-panel-inset\)\s*\+\s*var\(--floating-panel-border-width\)\s*\+\s*var\(--workspace-tab-row-inset\)\s*\)\s*\);/u)
    expect(dockView).toContain('useLayoutEffect')
    expect(dockView).toContain('--workspace-panel-toggle-top')
    expect(styles).not.toMatch(/\.workspace-panel-actions\s*\{[^}]*top:/u)
    expect(styles).toMatch(/\.workspace-panel-reopen-icon\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*24px;[\s\S]*?border-radius:\s*var\(--radius-icon\);/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-collapsed \.workspace-panel-reopen-target\.reopen-visible \.workspace-panel-reopen-icon,[\s\S]*?border-color:\s*var\(--border-strong\);/u)
    expect(styles).toMatch(/\.workspace-panel-reopen-label\s*\{[\s\S]*?width:\s*var\(--composer-hover-tip-width\);[\s\S]*?min-height:\s*var\(--composer-hover-tip-min-height\);[\s\S]*?padding:\s*var\(--composer-hover-tip-padding-block\) var\(--composer-hover-tip-padding-inline\);[\s\S]*?background:\s*var\(--composer-hover-tip-background\);[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*0 14px 36px rgba\(0, 0, 0, 0\.44\);[\s\S]*?font-size:\s*var\(--composer-hover-tip-font-size\);/u)
    expect(styles).toMatch(/\.workspace-panel-reopen-label\s*\{[\s\S]*?font-weight:\s*600;[\s\S]*?white-space:\s*pre-wrap;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?word-break:\s*break-word;/u)
    expect(panelView).not.toContain('workspace-context-line')
    expect(panelView).not.toContain("'目标工作区'")
    expect(panelView).not.toContain("'默认工作区'")
    expect(styles).not.toContain('.workspace-context-line')
    expect(styles).toMatch(/\.sidebar-toggle-btn\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*24px;[\s\S]*?border-radius:\s*var\(--radius-icon\);[\s\S]*?transition:/u)
    expect(styles).toMatch(/\.sidebar-toggle-icon\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*14px;[\s\S]*?shape-rendering:\s*geometricPrecision;/u)
    expect(styles).toMatch(/\.sidebar-toggle-outline,\s*\.sidebar-toggle-divider\s*\{[\s\S]*?stroke-width:\s*1;[\s\S]*?vector-effect:\s*non-scaling-stroke;/u)
    expect(styles).toMatch(/\.sidebar-toggle-divider\s*\{[\s\S]*?transform var\(--sidebar-collapse-motion\) var\(--motion-ease\)/u)
    expect(styles).toMatch(/\.workspace-panel-toggle-icon \.sidebar-toggle-divider\s*\{[^}]*transform:\s*translateX\(-4px\);/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-collapsed \.workspace-panel-toggle-icon \.sidebar-toggle-divider,[\s\S]*?transform:\s*translateX\(0\);/u)
    expect(styles).toMatch(/\.messages\s*\{[^}]*padding:\s*24px var\(--chat-content-gutter\)/u)
    expect(styles).not.toContain('.window-shell.workspace-panel-collapsed .messages')
    expect(styles).not.toContain('.window-shell.workspace-panel-drag-collapsed .messages')
    expect(styles).not.toContain('transition: padding-top var(--workspace-panel-motion)')
  })

  it('reuses the compact split layout when the workspace becomes fullscreen', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.workspace-panel-contents\s*\{[^}]*padding:\s*var\(--workspace-tab-row-inset\) 12px 12px var\(--workspace-tab-row-inset\);/u)
    expect(styles).toMatch(/\.workspace-panel-body\s*\{[^}]*margin:\s*8px 0 0 8px;/u)
    expect(styles).toMatch(/\.workspace-panel-actions\s*\{[^}]*right:\s*calc\([\s\S]*?var\(--workspace-tab-row-height\)[\s\S]*?var\(--workspace-tab-row-gap\)[\s\S]*?display:\s*inline-flex;[^}]*align-items:\s*center;/u)
    expect(styles).toMatch(/\.workspace-panel-header\s*\{[^}]*height:\s*var\(--workspace-tab-row-height\);[^}]*padding-right:\s*67px;/u)
    expect(styles).toMatch(/\.workspace-panel-topbar\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*height:\s*var\(--workspace-tab-row-height\);/u)
    expect(styles).not.toMatch(/\.window-shell\.workspace-panel-(?:drag-)?fullscreen \.workspace-panel-(?:contents|header|body)/u)
    expect(styles).not.toMatch(/\.workspace-panel-contents\s*\{[^}]*transition:[^}]*padding/u)
    expect(styles).not.toMatch(/\.workspace-panel-header\s*\{[^}]*transition:[^}]*padding-right/u)
  })

  it('floats the task pill at the chat column top and clips the transcript to its edges', async () => {
    const styles = await readRendererStyleSource()
    const chatView = await readRendererFile('./app-shell/chat-view.tsx')
    const globalTitlebar = await readRendererFile('./sidebar/global-titlebar.tsx')
    const projections = await readRendererFile('./app-shell/app-controller-projections.ts')

    // The pill lives at the top of the chat column (to the right of the sidebar), not in the
    // window titlebar, and the chat projection owns what it renders, renames and stops.
    expect(chatView).toContain('className="running-pill-shell"')
    expect(chatView).toContain('<RunningPill')
    expect(globalTitlebar).not.toContain('RunningPill')
    const chatFields = projections.slice(projections.indexOf('chat: ['), projections.indexOf('],', projections.indexOf('chat: [')))
    expect(chatFields).toContain("'titlebarTask'")
    expect(chatFields).toContain("'renameSession'")
    expect(chatFields).toContain("'stop'")
    const appFields = projections.slice(projections.indexOf('app: ['), projections.indexOf('],', projections.indexOf('app: [')))
    expect(appFields).not.toContain("'titlebarTask'")

    // The overlay is click-through except for the pill, symmetric to the composer shell below.
    expect(styles).toMatch(/\.chat\s*\{[^}]*--task-pill-inset-top:\s*8px;[^}]*--task-pill-height:\s*24px;[^}]*--task-pill-overlay-height:\s*calc\(/u)
    expect(styles).toMatch(/\.running-pill-shell\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*z-index:\s*40;[^}]*pointer-events:\s*none;/u)
    expect(styles).toMatch(/\.running-pill-shell > \.running-pill-root\s*\{[^}]*pointer-events:\s*auto;/u)

    // The transcript's edges: clipped at the pill's top edge while it floats there, and never
    // reaching below the input's own bottom edge.
    expect(styles).toMatch(/\.chat\s*\{[^}]*--composer-shell-inset-bottom:\s*12px;/u)
    expect(styles).toMatch(/\.composer-shell\s*\{[^}]*padding:\s*var\(--composer-shell-inset-top\) var\(--chat-content-gutter\) var\(--composer-shell-inset-bottom\);/u)
    expect(styles).toMatch(/\.messages\s*\{[^}]*margin-bottom:\s*var\(--composer-shell-inset-bottom\);/u)
    expect(styles).toMatch(/\.chat:has\(> \.running-pill-shell\) \.messages\s*\{[^}]*margin-top:\s*var\(--task-pill-inset-top\);[^}]*padding-top:\s*var\(--task-pill-overlay-height\);[^}]*scroll-padding-top:\s*var\(--task-pill-overlay-height\);/u)

    // Pill and panel wear the composer's glass recipe; neither is nested inside another
    // backdrop-filtered element, so the blur has a real backdrop to sample.
    expect(styles).toMatch(/\.running-pill\s*\{[^}]*background:\s*var\(--composer-surface\);[^}]*border:\s*0;[^}]*-webkit-backdrop-filter:\s*blur\(18px\) saturate\(135%\);[^}]*backdrop-filter:\s*blur\(18px\) saturate\(135%\);/u)
    expect(styles).toMatch(/\.running-pill-panel\s*\{[^}]*background:\s*var\(--composer-surface\);[^}]*border:\s*0;[^}]*border-radius:\s*var\(--radius-composer-input\);[^}]*-webkit-backdrop-filter:\s*blur\(18px\) saturate\(135%\);[^}]*backdrop-filter:\s*blur\(18px\) saturate\(135%\);/u)
  })
})
