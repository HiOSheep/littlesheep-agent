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
    expect(styles).toMatch(/\.window-titlebar::before\s*\{[\s\S]*?width:\s*var\(--sidebar-active-width\);/u)
    expect(styles).toMatch(/\.primary-workspace::after\s*\{[\s\S]*?inset:\s*0 auto 0 var\(--sidebar-active-width\);[\s\S]*?width:\s*1px;[\s\S]*?background:\s*var\(--border\);/u)
    expect(styles).toMatch(/\.primary-workspace:has\(\.sidebar-resizer:hover\)::after/u)
    expect(styles).toMatch(/\.primary-workspace:has\(\.sidebar-resizer:focus-visible\)::after/u)
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
    expect(styles).toMatch(/\.sidebar-toggle-btn\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*24px;[\s\S]*?transition:/u)
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
