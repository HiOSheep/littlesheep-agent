import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'


async function readRendererFile(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}


describe('chat layout stability', () => {
  it('reserves symmetric scrollbar space and keeps the chat thumb visible', async () => {
    const styles = await readRendererFile('./styles.css')

    expect(styles).toMatch(/\.messages\s*\{[\s\S]*?scrollbar-gutter:\s*stable both-edges;/u)
    expect(styles).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*#383838;[^}]*background-clip:\s*content-box;/u)
    expect(styles).toMatch(/::-webkit-scrollbar-thumb:hover\s*\{[^}]*background:\s*#484848;[^}]*background-clip:\s*content-box;/u)
    expect(styles).not.toContain('.messages::-webkit-scrollbar-thumb')
  })

  it('does not fight disclosure height animations with per-frame anchor repairs', async () => {
    const chatView = await readRendererFile('./app-shell/chat-view.tsx')

    expect(chatView).toContain('captureDisclosureInteraction')
    expect(chatView).toContain('.agent-tool-row, .trace-toggle')
    expect(chatView).not.toContain('.agent-reasoning-toggle')
    expect(chatView).toContain('stickToBottomRef.current = false')
    expect(chatView).not.toContain("kind: 'anchor'")
    expect(chatView).not.toContain('anchor.getBoundingClientRect()')
    expect(chatView).not.toContain('disclosureInteractionVersion')
  })

  it('anchors viewport reflow to the currently visible bottom edge', async () => {
    const styles = await readRendererFile('./styles.css')
    const chatView = await readRendererFile('./app-shell/chat-view.tsx')

    expect(styles).toMatch(/\.messages\s*\{[^}]*overflow-anchor:\s*none;/u)
    expect(chatView).toContain('new ResizeObserver')
    expect(chatView).toContain('didChatViewportResize(previous, current)')
    expect(chatView).toContain('resolveBottomAnchoredScrollTop(previous, current)')
  })

  it('keeps Agent activity in one flat immediate flow with a stable Markdown reply surface', async () => {
    const styles = await readRendererFile('./styles.css')
    const assistantTurn = await readRendererFile('./chat/assistant-turn.tsx')
    const toolRow = await readRendererFile('./chat/agent-tool-row.tsx')

    expect(assistantTurn).toContain('className="assistant-activity-flow"')
    expect(assistantTurn).toContain('className="message assistant assistant-final assistant-response-stream"')
    expect(assistantTurn).toContain('<Markdown text={message.text} />')
    expect(assistantTurn).not.toContain('Boolean(message.activityCollapsed)')
    expect(assistantTurn).not.toContain('ActivityDisclosure')
    expect(toolRow).toContain('data-call-id={tool.callId}')
    expect(styles).toMatch(/\.agent-flow-row\s*\{[^}]*min-height:\s*24px;[^}]*background:\s*transparent;[^}]*border:\s*0;/u)
    expect(styles).toMatch(/\.agent-flow-row\.is-active::after\s*\{[^}]*animation:\s*agent-flow-sweep 2\.6s ease-out infinite;/u)
    expect(styles).not.toContain('.assistant-turn-header')
    expect(styles).not.toContain('.activity-command-header')
  })

  it('matches user messages to the active workspace-tab surface without inheriting tab geometry', async () => {
    const styles = await readRendererFile('./styles.css')

    expect(styles).toMatch(/\.workspace-active-item:hover,[\s\S]*?\.workspace-active-item\.active\s*\{[^}]*color:\s*var\(--text\);[^}]*background:\s*var\(--control-hover\);/u)
    expect(styles).toMatch(/\.message\.user\s*\{[^}]*margin-left:\s*auto;[^}]*padding:\s*4px 8px;[^}]*color:\s*var\(--text\);[^}]*background:\s*var\(--control-hover\);[^}]*border:\s*0;[^}]*box-shadow:\s*none;/u)
    expect(styles).toMatch(/\.message\s*\{[^}]*max-width:\s*min\(820px, 78%\);[^}]*border-radius:\s*var\(--radius-ui\);[^}]*overflow-wrap:\s*anywhere;/u)
  })

  it('matches the workspace edge and hover highlight to the sidebar treatment', async () => {
    const styles = await readRendererFile('./styles.css')

    expect(styles).not.toMatch(/\.workspace-panel-resizer::before\s*\{/u)
    expect(styles).toMatch(/\.workspace-panel::before\s*\{[^}]*inset:\s*0 auto 0 0;[^}]*z-index:\s*25;[^}]*width:\s*1px;[^}]*background:\s*var\(--border\);[^}]*opacity:\s*1;[^}]*pointer-events:\s*none;/u)
    expect(styles).toMatch(/\.workspace-panel-resizer:hover \+ \.workspace-panel::before/u)
    expect(styles).toMatch(/\.workspace-panel-resizer:focus-visible \+ \.workspace-panel::before/u)
    expect(styles).toMatch(/\.workspace-panel-resizer:hover \+ \.workspace-panel::before,[\s\S]*?body\.is-resizing-column \.window-shell\.workspace-panel-drag-live:not\(\.workspace-panel-drag-collapsed\):not\(\.workspace-panel-drag-fullscreen\) \.workspace-panel::before\s*\{[^}]*width:\s*2px;[^}]*background:\s*var\(--sidebar-resizer-active-color\);/u)
    expect(styles).toMatch(/\.workspace-panel\s*\{[^}]*border-top-left-radius:\s*var\(--radius-ui\);/u)
    expect(styles).toMatch(/\.workspace-panel\s*\{[^}]*background:\s*var\(--bg\);[^}]*box-shadow:\s*inset 0 0 0 1px var\(--border\);/u)
    expect(styles).not.toMatch(/\.workspace-panel\s*\{[^}]*background:\s*var\(--surface\);/u)
    expect(styles).not.toMatch(/\.workspace-panel::after\s*\{/u)
    expect(styles).toMatch(/\.workspace-panel\s*\{[^}]*transition:[\s\S]*?box-shadow var\(--workspace-panel-motion\) var\(--motion-ease\)[,;]/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-fullscreen \.workspace-panel,\s*\.window-shell\.workspace-panel-drag-fullscreen \.workspace-panel\s*\{[^}]*border-top-left-radius:\s*0;[^}]*box-shadow:\s*none;/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-collapsed \.workspace-panel::before,[\s\S]*?\.window-shell\.workspace-panel-drag-fullscreen \.workspace-panel::before\s*\{[^}]*opacity:\s*0;/u)
  })

  it('keeps one native sidebar corner without an idle divider until resize is active', async () => {
    const styles = await readRendererFile('./styles.css')

    expect(styles).toMatch(/--sidebar-resizer-width:\s*0px;/u)
    expect(styles).not.toMatch(/\.sidebar-resizer::before\s*\{/u)
    expect(styles).toMatch(/\.window-shell::before\s*\{[\s\S]*?inset:\s*32px auto 0 0;[\s\S]*?z-index:\s*1;[\s\S]*?width:\s*var\(--sidebar-active-width\);[\s\S]*?background-image:\s*var\(--sidebar-glass-texture\);[\s\S]*?border-top-right-radius:\s*var\(--radius-ui\);/u)
    expect(styles).toMatch(/\.window-shell::after\s*\{[^}]*inset:\s*32px auto auto calc\([\s\S]*?var\(--sidebar-active-width\) - var\(--radius-ui\) - var\(--radius-ui\)[\s\S]*?\);[^}]*z-index:\s*0;[^}]*width:\s*calc\(var\(--radius-ui\) \+ var\(--radius-ui\)\);[^}]*height:\s*calc\(var\(--radius-ui\) \+ var\(--radius-ui\)\);[^}]*background:\s*transparent;[^}]*border-radius:\s*var\(--radius-circle\);[^}]*box-shadow:\s*0 0 0 var\(--radius-ui\) var\(--bg\);[^}]*clip-path:\s*inset\(\s*0 calc\(0px - var\(--sidebar-resizer-width\)\)\s*calc\(var\(--radius-ui\) - 0\.5px\) var\(--radius-ui\)\s*\);/u)
    expect(styles).not.toMatch(/\.window-shell::after\s*\{[^}]*box-shadow:[^;]*var\(--sidebar-resizer-width\)/u)
    expect(styles).not.toMatch(/\.primary-workspace::before\s*\{/u)
    expect(styles).not.toMatch(/\.window-shell::after\s*\{[^}]*radial-gradient/u)
    expect(styles).not.toMatch(/\.window-titlebar::before\s*\{/u)
    expect(styles).not.toMatch(/\.sidebar::before\s*\{/u)
    expect(styles).not.toMatch(/\.settings-sidebar::before\s*\{/u)
    expect(styles).not.toMatch(/\.primary-workspace::after\s*\{/u)
    expect(styles).not.toMatch(/\.settings-sidebar-resizer::before\s*\{/u)
    expect(styles).toMatch(/\.sidebar-resizer\s*\{[^}]*width:\s*8px;[^}]*margin-left:\s*-4px;[^}]*margin-right:\s*-4px;/u)
    expect(styles).toMatch(/\.settings-sidebar-resizer\s*\{[^}]*width:\s*8px;[^}]*margin-left:\s*-4px;[^}]*margin-right:\s*-4px;/u)
    expect(styles).toMatch(/\.sidebar\s*\{[^}]*overflow:\s*hidden;[^}]*border-top-right-radius:\s*var\(--radius-ui\);/u)
    expect(styles).toMatch(/\.settings-sidebar\s*\{[^}]*overflow:\s*hidden;[^}]*border-top-right-radius:\s*var\(--radius-ui\);/u)
    expect(styles).toMatch(/\.sidebar::after,\s*\.settings-sidebar::after\s*\{[^}]*z-index:\s*2;[^}]*width:\s*2px;[^}]*background:\s*var\(--sidebar-resizer-active-color\);[^}]*opacity:\s*0;[^}]*transition:\s*opacity var\(--motion-fast\) var\(--motion-ease\);/u)
    expect(styles).toMatch(/\.sidebar::after,\s*\.settings-sidebar::after\s*\{[^}]*inset:\s*0 0 0 auto;/u)
    expect(styles).toMatch(/\.primary-workspace:has\(\.sidebar-resizer:hover\) \.sidebar::after/u)
    expect(styles).toMatch(/\.settings-layout:has\(\.settings-sidebar-resizer:hover\) \.settings-sidebar::after/u)
    expect(styles).toMatch(/\.primary-workspace:has\(\.sidebar-resizer:hover\) \.sidebar::after,[\s\S]*?body\.is-resizing-column \.window-shell\.sidebar-drag-live \.settings-sidebar::after\s*\{[^}]*opacity:\s*1;/u)
  })

  it('keeps the composer above messages with dynamic clearance and glass material', async () => {
    const styles = await readRendererFile('./styles.css')
    const composer = await readRendererFile('./app-shell/composer-view.tsx')

    expect(styles).toMatch(/--composer-overlay-height:\s*116px;/u)
    expect(styles).toMatch(/\.messages\s*\{[\s\S]*?calc\(var\(--composer-overlay-height\) \+ var\(--composer-message-gap\)\);[\s\S]*?scroll-padding-bottom:[\s\S]*?var\(--composer-overlay-height\)/u)
    expect(styles).toMatch(/\.composer-shell\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;[\s\S]*?z-index:\s*40;[\s\S]*?pointer-events:\s*none;/u)
    expect(styles).toMatch(/\.composer\s*\{[\s\S]*?background:\s*rgba\(32, 32, 32, 0\.75\);[\s\S]*?-webkit-backdrop-filter:\s*blur\(18px\) saturate\(135%\);[\s\S]*?backdrop-filter:\s*blur\(18px\) saturate\(135%\);/u)
    expect(styles).toMatch(/\.composer\s*\{[^}]*border:\s*0;/u)
    expect(styles).not.toMatch(/\.composer\.drag-active\s*\{[^}]*border-color:/u)
    expect(composer).toContain('useLayoutEffect')
    expect(composer).toContain('ResizeObserver')
    expect(composer).toContain('--composer-overlay-height')
  })

  it('keeps the shared sidebar material transparent to content and native-window backed', async () => {
    const styles = await readRendererFile('./styles.css')
    const desktopShell = await readRendererFile('../main/desktop-shell.ts')
    const texture = await readFile(new URL('./assets/sidebar-wash-dithered.png', import.meta.url))

    expect(texture.byteLength).toBeGreaterThan(10_000)
    expect(styles).toMatch(/--bg:\s*#141414;/u)
    expect(styles).toMatch(/--sidebar-glass-opacity:\s*0\.5;/u)
    expect(styles).toMatch(/\.sidebar\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?opacity:\s*1;/u)
    expect(styles).toMatch(/\.settings-sidebar\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?opacity:\s*1;/u)
    expect(styles).toMatch(/\.window-titlebar\s*\{[\s\S]*?background:\s*var\(--bg\);/u)
    expect(styles).not.toContain('mask-image')
    expect(styles).not.toContain('sidebar-corner-mask')
    expect(desktopShell).toContain("transparent: false")
    expect(desktopShell).toContain("backgroundMaterial: 'acrylic'")
    expect(desktopShell).toContain("color: '#141414'")
    expect(desktopShell).toContain("process.platform === 'win32' ? '#00000000' : '#141414'")
    expect(desktopShell).toContain('roundedCorners: true')
    expect(desktopShell).toContain('thickFrame: true')
    expect(desktopShell).toContain('hasShadow: true')
    expect(desktopShell).not.toContain('transparent: true')
  })

  it('keeps answer separators as a single soft 50 percent white rule', async () => {
    const styles = await readRendererFile('./styles.css')

    expect(styles).toMatch(/\.message \.markdown hr\s*\{[\s\S]*?height:\s*0;[\s\S]*?border:\s*0;[\s\S]*?border-top:\s*1px solid rgba\(255, 255, 255, 0\.5\);/u)
  })

  it('keeps the settings entry equally inset from the sidebar left and bottom edges', async () => {
    const styles = await readRendererFile('./styles.css')

    expect(styles).toMatch(/--sidebar-content-block-inset:\s*18px;/u)
    expect(styles).toMatch(/--sidebar-content-inline-inset:\s*14px;/u)
    expect(styles).toMatch(/--settings-entry-left:\s*var\(--sidebar-content-block-inset\);/u)
    expect(styles).toMatch(/--settings-entry-bottom:\s*var\(--sidebar-content-block-inset\);/u)
    expect(styles).toMatch(/--settings-entry-collapsed-width:\s*37px;/u)
    expect(styles).toMatch(/--settings-origin-x:\s*calc\(var\(--settings-entry-left\) \+ \(var\(--settings-entry-collapsed-width\) \/ 2\)\);/u)
    expect(styles).toMatch(/--settings-origin-y:\s*calc\(100% - var\(--settings-entry-bottom\) - \(var\(--settings-entry-height\) \/ 2\)\);/u)
    expect(styles).toMatch(/--settings-entry-height:\s*34px;/u)
    expect(styles).toMatch(/\.sidebar-contents\s*\{[^}]*padding:\s*var\(--sidebar-content-block-inset\) var\(--sidebar-content-inline-inset\);/u)
    expect(styles).toMatch(/\.settings-sidebar-contents\s*\{[^}]*padding:\s*var\(--sidebar-content-block-inset\) var\(--sidebar-content-inline-inset\);/u)
    expect(styles).toMatch(/\.sidebar-footer\s*\{[^}]*min-height:\s*calc\(var\(--settings-entry-height\) \+ var\(--sidebar-content-inline-inset\)\);[^}]*padding-top:\s*var\(--sidebar-content-inline-inset\);[^}]*padding-left:\s*calc\(var\(--sidebar-content-block-inset\) - var\(--sidebar-content-inline-inset\)\);/u)
    expect(styles).not.toMatch(/\.sidebar-footer\s*\{[^}]*padding-bottom:/u)
    expect(styles).toMatch(/\.settings-entry-btn\s*\{[^}]*min-width:\s*var\(--settings-entry-collapsed-width\);[^}]*height:\s*var\(--settings-entry-height\);/u)
    expect(styles).toMatch(/\.sidebar-footer\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*flex-start;/u)
    expect(styles).toMatch(/\.settings-entry-bridge\s*\{[^}]*left:\s*var\(--settings-entry-left\);[^}]*top:\s*auto;[^}]*bottom:\s*var\(--settings-entry-bottom\);[^}]*min-width:\s*var\(--settings-entry-collapsed-width\);[^}]*max-width:\s*var\(--settings-entry-collapsed-width\);[^}]*height:\s*var\(--settings-entry-height\);/u)
    expect(styles).toMatch(/\.settings-entry-btn::after,\s*\.settings-entry-bridge::after\s*\{[^}]*left:\s*calc\(var\(--settings-entry-collapsed-width\) \/ 2\);/u)
    expect(styles).not.toMatch(/\.settings-sidebar-footer\s*\{[^}]*padding-left:\s*0;/u)
  })

  it('does not paint the ordinary sidebar beneath translucent settings content', async () => {
    const styles = await readRendererFile('./styles.css')

    const sidebarView = await readRendererFile('./app-shell/sidebar-view.tsx')

    expect(styles).toMatch(/\.window-shell\.settings-open \.primary-workspace \.sidebar-contents,\s*\.window-shell:has\(> \.presence-layer:not\(\.presence-exiting\) \.settings-workspace\) \.primary-workspace \.sidebar-contents\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;[^}]*transition:\s*none;/u)
    expect(styles).not.toMatch(/\.window-shell:has\(> \.presence-layer \.settings-workspace\) \.primary-workspace \.sidebar-contents/u)
    expect(styles).toMatch(/\.window-shell:has\(> \.presence-layer\.presence-exiting \.settings-workspace\) \.primary-workspace \.sidebar-contents\s*\{[^}]*opacity:\s*var\(--sidebar-content-opacity\);[^}]*visibility:\s*visible;[^}]*pointer-events:\s*none;[^}]*transition:[\s\S]*?var\(--settings-sidebar-exit-reveal-delay\)/u)
    expect(styles).toMatch(/\.presence-layer\.presence-exiting \.settings-sidebar-contents\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;[^}]*transition:[\s\S]*?var\(--settings-sidebar-exit-content-motion\)/u)
    expect(styles).not.toMatch(/\.window-shell\.settings-open \.primary-workspace\s*\{[^}]*display:\s*none;/u)
    expect(styles).toMatch(/\.presence-layer\.visible \.settings-workspace\s*\{[^}]*clip-path:\s*circle\(150vmax at var\(--settings-origin-x\) var\(--settings-origin-y\)\);/u)
    expect(sidebarView).toContain('onClick={() => {')
    expect(sidebarView).not.toContain('onMouseDown={() => {')
  })

  it('keeps the edge reveal entry and one stationary animated corner toggle above chat', async () => {
    const styles = await readRendererFile('./styles.css')
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
    expect(styles).not.toMatch(/\.workspace-panel-corner-toggle\s*\{[^}]*top:/u)
    expect(styles).not.toMatch(/\.workspace-panel-actions\s*\{[^}]*top:/u)
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
    const styles = await readRendererFile('./styles.css')

    expect(styles).toMatch(/\.workspace-panel-contents\s*\{[^}]*padding:\s*var\(--workspace-tab-row-inset\) 12px 12px var\(--workspace-tab-row-inset\);/u)
    expect(styles).toMatch(/\.workspace-panel-body\s*\{[^}]*margin:\s*8px 0 0 8px;/u)
    expect(styles).toMatch(/\.workspace-panel-actions\s*\{[^}]*right:\s*41px;[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;/u)
    expect(styles).toMatch(/\.workspace-panel-header\s*\{[^}]*height:\s*var\(--workspace-tab-row-height\);[^}]*padding-right:\s*67px;/u)
    expect(styles).toMatch(/\.workspace-panel-topbar\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*height:\s*var\(--workspace-tab-row-height\);/u)
    expect(styles).not.toMatch(/\.window-shell\.workspace-panel-(?:drag-)?fullscreen \.workspace-panel-(?:contents|header|body)/u)
    expect(styles).not.toMatch(/\.workspace-panel-contents\s*\{[^}]*transition:[^}]*padding/u)
    expect(styles).not.toMatch(/\.workspace-panel-header\s*\{[^}]*transition:[^}]*padding-right/u)
  })
})
