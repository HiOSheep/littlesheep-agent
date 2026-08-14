import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'


describe('composer control surfaces', () => {
  it('reuses the workspace tab frame treatment across non-submit controls', async () => {
    const [
      styles,
      addMenu,
      modePicker,
      runtimePicker,
      workspaceChip,
      contextUsage,
      composerView,
    ] = await Promise.all([
      readFile(new URL('../styles.css', import.meta.url), 'utf8'),
      readFile(new URL('./add-menu.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./mode-picker.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./runtime-picker.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./workspace-chip.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./context-usage-indicator.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../app-shell/composer-view.tsx', import.meta.url), 'utf8'),
    ])

    for (const source of [addMenu, modePicker, runtimePicker, workspaceChip, contextUsage]) {
      expect(source).toContain('composer-tab-control')
    }

    const sharedSurface = styles.match(/\.composer-tab-control\s*\{([^}]*)\}/u)?.[1] ?? ''
    expect(sharedSurface).toContain('background: transparent;')
    expect(sharedSurface).toContain('border: 0;')
    expect(sharedSurface).toContain('border-radius: var(--radius-ui);')
    expect(sharedSurface).toContain('outline: 0;')
    expect(sharedSurface).toContain('background-color var(--motion-fast) var(--motion-ease)')
    expect(sharedSurface).toContain('color var(--motion-fast) var(--motion-ease)')
    expect(styles).toMatch(
      /\.composer-tab-control:hover:not\(:disabled\),\s*\.composer-tab-control:focus-visible,\s*\.workspace-context-chip\.composer-tab-control:focus-within,\s*\.composer-tab-control\[aria-expanded="true"\]\s*\{[^}]*background:\s*var\(--control-hover\);/u,
    )
    expect(styles.indexOf('.composer-tab-control {')).toBeGreaterThan(styles.indexOf('.workspace-context-chip {'))
    expect(composerView).not.toMatch(/className="send-round[^"]*composer-tab-control/u)
  })
})
