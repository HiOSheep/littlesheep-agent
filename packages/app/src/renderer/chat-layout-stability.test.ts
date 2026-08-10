import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'


async function readRendererFile(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}


describe('chat layout stability', () => {
  it('reserves symmetric scrollbar space before disclosures change content height', async () => {
    const styles = await readRendererFile('./styles.css')

    expect(styles).toMatch(/\.messages\s*\{[\s\S]*?scrollbar-gutter:\s*stable both-edges;/u)
  })

  it('does not fight disclosure height animations with per-frame anchor repairs', async () => {
    const chatView = await readRendererFile('./app-shell/chat-view.tsx')

    expect(chatView).toContain('captureDisclosureInteraction')
    expect(chatView).toContain('.assistant-turn-header, .activity-disclosure-header, .activity-command-header, .trace-toggle')
    expect(chatView).toContain('stickToBottomRef.current = false')
    expect(chatView).not.toContain("kind: 'anchor'")
    expect(chatView).not.toContain('anchor.getBoundingClientRect()')
    expect(chatView).not.toContain('disclosureInteractionVersion')
  })

  it('draws one workspace separator on the actual panel color boundary', async () => {
    const styles = await readRendererFile('./styles.css')

    expect(styles).not.toMatch(/\.workspace-panel-resizer::before\s*\{/u)
    expect(styles).toMatch(/\.workspace-panel::before\s*\{[\s\S]*?inset:\s*0 auto 0 0;[\s\S]*?width:\s*1px;[\s\S]*?background:\s*var\(--border\);/u)
    expect(styles).toMatch(/\.workspace-panel-resizer:hover \+ \.workspace-panel::before/u)
    expect(styles).toMatch(/\.workspace-panel-resizer:focus-visible \+ \.workspace-panel::before/u)
    expect(styles).toMatch(/\.workspace-panel\s*\{[^}]*border-top-left-radius:\s*var\(--radius-ui\);/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-fullscreen \.workspace-panel,\s*\.window-shell\.workspace-panel-drag-fullscreen \.workspace-panel\s*\{[^}]*border-top-left-radius:\s*0;/u)
  })

  it('draws one full-height sidebar separator on the shared color boundary', async () => {
    const styles = await readRendererFile('./styles.css')

    expect(styles).not.toMatch(/\.sidebar-resizer::before\s*\{/u)
    expect(styles).toMatch(/\.window-shell::before\s*\{[\s\S]*?inset:\s*32px auto 0 0;[\s\S]*?width:\s*var\(--sidebar-active-width\);[\s\S]*?background-image:\s*var\(--sidebar-glass-texture\);/u)
    expect(styles).not.toMatch(/\.window-titlebar::before\s*\{/u)
    expect(styles).toMatch(/\.primary-workspace::after\s*\{[\s\S]*?inset:\s*0 auto 0 var\(--sidebar-active-width\);[\s\S]*?width:\s*1px;[\s\S]*?background:\s*var\(--border\);/u)
    expect(styles).toMatch(/\.primary-workspace:has\(\.sidebar-resizer:hover\)::after/u)
    expect(styles).toMatch(/\.primary-workspace:has\(\.sidebar-resizer:focus-visible\)::after/u)
  })

  it('keeps the composer above messages with dynamic clearance and glass material', async () => {
    const styles = await readRendererFile('./styles.css')
    const composer = await readRendererFile('./app-shell/composer-view.tsx')

    expect(styles).toMatch(/--composer-overlay-height:\s*116px;/u)
    expect(styles).toMatch(/\.messages\s*\{[\s\S]*?calc\(var\(--composer-overlay-height\) \+ var\(--composer-message-gap\)\);[\s\S]*?scroll-padding-bottom:[\s\S]*?var\(--composer-overlay-height\)/u)
    expect(styles).toMatch(/\.composer-shell\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;[\s\S]*?z-index:\s*40;[\s\S]*?pointer-events:\s*none;/u)
    expect(styles).toMatch(/\.composer\s*\{[\s\S]*?background:\s*rgba\(32, 32, 32, 0\.75\);[\s\S]*?-webkit-backdrop-filter:\s*blur\(18px\) saturate\(135%\);[\s\S]*?backdrop-filter:\s*blur\(18px\) saturate\(135%\);/u)
    expect(composer).toContain('useLayoutEffect')
    expect(composer).toContain('ResizeObserver')
    expect(composer).toContain('--composer-overlay-height')
  })

  it('keeps the shared sidebar material transparent to content and native-window backed', async () => {
    const styles = await readRendererFile('./styles.css')
    const desktopShell = await readRendererFile('../main/desktop-shell.ts')
    const texture = await readFile(new URL('./assets/sidebar-wash-dithered.png', import.meta.url))

    expect(texture.byteLength).toBeGreaterThan(10_000)
    expect(styles).toMatch(/--sidebar-glass-opacity:\s*0\.5;/u)
    expect(styles).toMatch(/\.sidebar\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?opacity:\s*1;/u)
    expect(styles).toMatch(/\.settings-sidebar\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?opacity:\s*1;/u)
    expect(styles).toMatch(/\.window-titlebar\s*\{[\s\S]*?background:\s*var\(--bg\);/u)
    expect(styles).not.toContain('mask-image')
    expect(styles).not.toContain('sidebar-corner-mask')
    expect(desktopShell).toContain("transparent: false")
    expect(desktopShell).toContain("backgroundMaterial: 'acrylic'")
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

    expect(styles).toMatch(/\.window-shell\.settings-open \.primary-workspace \.sidebar-contents,\s*\.window-shell:has\(> \.presence-layer \.settings-workspace\) \.primary-workspace \.sidebar-contents\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;[^}]*transition:\s*none;/u)
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
    expect(dockView).toContain('className="sidebar-toggle-btn workspace-panel-corner-toggle"')
    expect(dockView).toContain('<SidebarToggleIcon className="workspace-panel-toggle-icon" />')
    expect(panelView).not.toContain('onToggleCollapsed')
    expect(styles).toMatch(/\.workspace-panel-reopen-target\s*\{[\s\S]*?top:\s*50%;/u)
    expect(styles).toMatch(/\.workspace-panel-corner-toggle\s*\{[\s\S]*?top:\s*14px;[\s\S]*?right:\s*12px;/u)
    expect(styles).toMatch(/\.sidebar-toggle-btn\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*24px;[\s\S]*?border-radius:\s*var\(--radius-icon\);[\s\S]*?transition:/u)
    expect(styles).toMatch(/\.sidebar-toggle-icon\s*\{[\s\S]*?width:\s*18px;[\s\S]*?height:\s*14px;[\s\S]*?shape-rendering:\s*geometricPrecision;/u)
    expect(styles).toMatch(/\.sidebar-toggle-outline,\s*\.sidebar-toggle-divider\s*\{[\s\S]*?stroke-width:\s*1;[\s\S]*?vector-effect:\s*non-scaling-stroke;/u)
    expect(styles).toMatch(/\.sidebar-toggle-divider\s*\{[\s\S]*?transform var\(--sidebar-collapse-motion\) var\(--motion-ease\)/u)
    expect(styles).toMatch(/\.workspace-panel-toggle-icon \.sidebar-toggle-divider\s*\{[^}]*transform:\s*translateX\(-4px\);/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-collapsed \.workspace-panel-toggle-icon \.sidebar-toggle-divider,[\s\S]*?transform:\s*translateX\(0\);/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-collapsed \.messages,\s*\.window-shell\.workspace-panel-drag-collapsed \.messages\s*\{[^}]*padding-top:\s*52px;/u)
  })

  it('keeps the fullscreen control anchored while workspace content padding changes', async () => {
    const styles = await readRendererFile('./styles.css')

    expect(styles).toMatch(/\.workspace-panel-actions\s*\{[^}]*position:\s*absolute;[^}]*top:\s*14px;[^}]*right:\s*41px;[^}]*margin:\s*0;[^}]*padding:\s*0;/u)
    expect(styles).toMatch(/\.workspace-panel-header\s*\{[^}]*padding-right:\s*67px;[^}]*transition:\s*padding-right var\(--workspace-panel-motion\) var\(--motion-ease\);/u)
    expect(styles).toMatch(/\.window-shell\.workspace-panel-fullscreen \.workspace-panel-header,\s*\.window-shell\.workspace-panel-drag-fullscreen \.workspace-panel-header\s*\{[^}]*padding-right:\s*calc\(79px - clamp\(16px, 2\.6vw, 36px\)\);/u)
  })
})
