import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
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
      workspaceAddMenu,
    ] = await Promise.all([
      readRendererStyleSource(),
      readFile(new URL('./add-menu.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./mode-picker.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./runtime-picker.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./workspace-chip.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./context-usage-indicator.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../app-shell/composer-view.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../workspace/add-menu.tsx', import.meta.url), 'utf8'),
    ])
    const rootRule = styles.match(/:root\s*\{([\s\S]*?)\}/u)?.[1] ?? ''
    const floatingHelpRule = styles.match(/\.floating-help-tip\s*\{([^}]*)\}/u)?.[1] ?? ''
    const compactComposerStyles = styles.slice(
      styles.indexOf('@container chat-pane (max-width: 520px)'),
      styles.indexOf('@media (max-width: 860px)'),
    )

    expect(styles).toMatch(
      /\.add-menu-trigger::before,\s*\.add-menu-trigger::after\s*\{[^}]*height:\s*1px;/u,
    )
    expect(styles).toMatch(
      /\.add-menu-trigger\.composer-tab-control\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*flex:\s*0 0 28px;[^}]*border-radius:\s*var\(--radius-circle\);/u,
    )
    expect(styles).toMatch(
      /\.add-menu-trigger\.composer-tab-control\s*\{[^}]*border:\s*0;/u,
    )
    expect(styles).toMatch(
      /\.add-menu-trigger\.composer-tab-control:hover:not\(:disabled\),\s*\.add-menu-trigger\.composer-tab-control:focus-visible,\s*\.add-menu\.open \.add-menu-trigger\.composer-tab-control\s*\{[^}]*background:\s*var\(--control-active\);[^}]*border:\s*0;[^}]*outline:\s*0;/u,
    )
    expect(addMenu).not.toContain('buildFloatingHelpTip')
    expect(addMenu).not.toMatch(/onMouseEnter=|onMouseMove=|onFocus=/u)
    expect(modePicker).toContain('mode-picker-content')

    for (const source of [addMenu, modePicker, runtimePicker, workspaceChip, contextUsage]) {
      expect(source).toContain('composer-tab-control')
    }

    const sharedSurface = styles.match(/\.composer-tab-control\s*\{([^}]*)\}/u)?.[1] ?? ''
    expect(sharedSurface).toContain('height: var(--composer-control-surface-size);')
    expect(sharedSurface).toContain('background: transparent;')
    expect(sharedSurface).toContain('border: 0;')
    expect(sharedSurface).toContain('border-radius: var(--radius-ui);')
    expect(sharedSurface).toContain('outline: 0;')
    expect(sharedSurface).toContain('background-color var(--motion-fast) var(--motion-ease)')
    expect(sharedSurface).toContain('color var(--motion-fast) var(--motion-ease)')
    expect(styles).toMatch(
      /\.composer-tab-control:hover:not\(:disabled\):not\(\.context-usage\),\s*\.composer-tab-control:focus-visible,\s*\.workspace-context-chip\.composer-tab-control:focus-within,\s*\.composer-tab-control\[aria-expanded="true"\]\s*\{[^}]*background:\s*var\(--control-hover\);/u,
    )
    expect(styles).toMatch(
      /\.runtime-picker-trigger\.composer-tab-control:hover:not\(:disabled\),\s*\.runtime-picker-trigger\.composer-tab-control:focus-visible,\s*\.runtime-picker\.open \.runtime-picker-trigger\.composer-tab-control\s*\{[^}]*background:\s*var\(--control-active\);/u,
    )
    expect(styles.indexOf('.composer-tab-control {')).toBeGreaterThan(styles.indexOf('.workspace-context-chip {'))
    expect(styles).toMatch(/\.workspace-panel-surface\s*\{[^}]*box-sizing:\s*border-box;[^}]*background:\s*transparent;[^}]*border:\s*var\(--floating-panel-border-width\) solid var\(--floating-panel-frame-color\);[^}]*border-radius:\s*var\(--radius-floating-panel\);[^}]*box-shadow:\s*var\(--floating-panel-shadow\);/u)
    expect(styles).toMatch(/\.sidebar-surface::before,\s*\.workspace-panel-surface::before\s*\{[^}]*background:\s*var\(--sidebar-glass-fill\);[^}]*-webkit-backdrop-filter:\s*blur\(20px\) saturate\(145%\);[^}]*backdrop-filter:\s*blur\(20px\) saturate\(145%\);/u)
    expect(styles).not.toMatch(/\.workspace-panel::before\s*\{/u)
    expect(styles).toMatch(/\.workspace-empty-launcher-item\s*\{[^}]*border:\s*0;/u)
    expect(styles).toMatch(
      /\.workspace-empty-launcher-item:hover,\s*\.workspace-empty-launcher-item:focus-visible\s*\{[^}]*background:\s*var\(--control-hover\);[^}]*outline:\s*0;/u,
    )
    expect(styles).not.toMatch(
      /\.workspace-empty-launcher-item\s*\{[^}]*transition:[^}]*border-color/u,
    )
    expect(styles).toMatch(
      /\.workspace-add-panel\s*\{[^}]*width:\s*min\(282px, calc\(100vw - 20px\)\);[^}]*border:\s*0;[^}]*box-shadow:\s*none;[^}]*outline:\s*0;/u,
    )
    expect(styles).toMatch(
      /\.workspace-add-item\s*\{[^}]*border:\s*0;[^}]*box-shadow:\s*none;[^}]*outline:\s*0;/u,
    )
    expect(styles).not.toMatch(
      /\.workspace-add-item:hover,[\s\S]*?\.workspace-add-item\.active\s*\{[^}]*border-color/u,
    )
    expect(workspaceAddMenu).toContain('panelRef.current?.offsetWidth || 282')
    expect(styles).toMatch(
      /\.model-picker-trigger\s*\{[^}]*padding:\s*0 var\(--composer-control-padding-inline\);/u,
    )
    expect(styles).toMatch(
      /\.runtime-picker-trigger\s*\{[^}]*padding:\s*0 var\(--composer-control-padding-inline\);/u,
    )
    expect(styles).toMatch(
      /\.model-picker-trigger\s*\{[^}]*--picker-arrow-gap:\s*8px;[^}]*gap:\s*var\(--picker-arrow-gap\);/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-trigger\s*\{[^}]*--picker-arrow-gap:\s*7px;[^}]*gap:\s*var\(--picker-arrow-gap\);/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-trigger\s*\{[^}]*justify-content:\s*flex-start;/u,
    )
    expect(styles).toMatch(
      /\.runtime-picker-trigger\s*\{[^}]*--picker-arrow-gap:\s*9px;[^}]*gap:\s*var\(--picker-arrow-gap\);/u,
    )
    expect(compactComposerStyles).toMatch(
      /\.mode-picker-trigger\s*\{[^}]*--picker-arrow-gap:\s*5px;[^}]*gap:\s*var\(--picker-arrow-gap\);/u,
    )
    expect(compactComposerStyles).toMatch(
      /\.runtime-picker-trigger\s*\{[^}]*--picker-arrow-gap:\s*6px;[^}]*gap:\s*var\(--picker-arrow-gap\);/u,
    )
    expect(styles).toMatch(
      /\.model-picker-trigger::after,\s*\.runtime-picker-trigger::after\s*\{[^}]*width:\s*0;[^}]*height:\s*0;[^}]*flex:\s*0 0 0;[^}]*margin-left:\s*calc\(var\(--picker-arrow-gap\) \* -1\);[^}]*border-right:\s*0 solid currentColor;[^}]*border-bottom:\s*0 solid currentColor;[^}]*opacity:\s*0;/u,
    )
    expect(styles).toMatch(
      /\.model-picker-trigger:hover:not\(:disabled\)::after,\s*\.model-picker-trigger:focus-visible::after,\s*\.runtime-picker-trigger:hover:not\(:disabled\)::after,\s*\.runtime-picker-trigger:focus-visible::after\s*\{[^}]*width:\s*7px;[^}]*height:\s*7px;[^}]*flex-basis:\s*7px;[^}]*opacity:\s*0\.76;/u,
    )
    expect(styles).toMatch(
      /\.model-picker\.open \.model-picker-trigger::after,\s*\.runtime-picker\.open \.runtime-picker-trigger::after\s*\{[^}]*width:\s*7px;[^}]*height:\s*7px;[^}]*flex-basis:\s*7px;[^}]*opacity:\s*0\.76;/u,
    )
    expect(styles).toMatch(
      /\.model-picker-trigger:hover:not\(:disabled\)::after,\s*\.model-picker-trigger:focus-visible::after,\s*\.runtime-picker-trigger:hover:not\(:disabled\)::after,\s*\.runtime-picker-trigger:focus-visible::after\s*\{[^}]*transform:\s*translateY\(-1px\) rotate\(45deg\) scale\(1\);/u,
    )
    expect(styles).toMatch(
      /\.model-picker\.open \.model-picker-trigger::after,\s*\.runtime-picker\.open \.runtime-picker-trigger::after\s*\{[^}]*transform:\s*translateY\(1px\) rotate\(225deg\) scale\(1\);/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-content\s*\{[^}]*transform:\s*none;[^}]*transition:\s*none;/u,
    )
    expect(styles).toMatch(
      /\.model-picker-trigger::after,\s*\.runtime-picker-trigger::after\s*\{[^}]*transition:[\s\S]*?width var\(--motion-slow\)[\s\S]*?margin-left var\(--motion-slow\)[\s\S]*?opacity var\(--motion-slow\)[\s\S]*?transform var\(--motion-slow\)/u,
    )
    expect(styles).toMatch(
      /\.model-picker-trigger:hover:not\(:disabled\)::after,\s*\.model-picker-trigger:focus-visible::after,\s*\.runtime-picker-trigger:hover:not\(:disabled\)::after,\s*\.runtime-picker-trigger:focus-visible::after\s*\{[^}]*transform:\s*translateY\(-1px\) rotate\(45deg\) scale\(1\);/u,
    )
    expect(styles).toMatch(
      /\.model-picker\.open \.model-picker-trigger::after,\s*\.runtime-picker\.open \.runtime-picker-trigger::after\s*\{[^}]*transform:\s*translateY\(1px\) rotate\(225deg\) scale\(1\);/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-content\s*\{[^}]*transform:\s*none;[^}]*transition:\s*none;/u,
    )
    expect(styles).toMatch(
      /\.workspace-context-chip\s*\{[^}]*padding:\s*0 28px 0 var\(--composer-control-padding-inline\);/u,
    )
    expect(floatingHelpRule).toContain('box-sizing: border-box;')
    expect(floatingHelpRule).toContain('width: var(--composer-hover-tip-width);')
    expect(floatingHelpRule).toContain('min-height: var(--composer-hover-tip-min-height);')
    expect(floatingHelpRule).toContain('background: var(--composer-hover-tip-background);')
    expect(floatingHelpRule).toContain('border: 0;')
    expect(floatingHelpRule).toContain('font-size: var(--composer-hover-tip-font-size);')
    expect(rootRule).toContain('--composer-hover-tip-width: 80px;')
    expect(rootRule).toContain('--composer-hover-tip-min-height: 27px;')
    expect(rootRule).toContain('--composer-hover-tip-padding-block: 4px;')
    expect(rootRule).toContain('--composer-hover-tip-padding-inline: 8px;')
    expect(rootRule).toContain('--composer-hover-tip-font-size: 12px;')
    expect(rootRule).toContain('--composer-hover-tip-background: var(--control-hover);')
    expect(rootRule).toContain(
      '--composer-picker-option-hover: color-mix(in srgb, var(--text) 12%, var(--control-hover));',
    )
    expect(rootRule).toContain(
      '--composer-picker-option-active: color-mix(in srgb, var(--text) 18%, var(--control-hover));',
    )
    expect(styles).toMatch(
      /\.runtime-menu-item:hover:not\(:disabled\),\s*\.runtime-menu-item:focus-visible\s*\{[^}]*background:\s*var\(--composer-picker-option-hover\);/u,
    )
    expect(styles).toMatch(
      /\.runtime-menu-item\.active,\s*\.runtime-model-option\.active,\s*\.runtime-reasoning-option\.active\s*\{[^}]*background:\s*var\(--composer-picker-option-active\);/u,
    )
    expect(styles).toMatch(
      /\.runtime-menu-shell \.runtime-menu-item:hover:not\(:disabled\),\s*\.runtime-menu-shell \.runtime-menu-item:focus-visible,\s*\.runtime-menu-shell \.runtime-menu-item\.active\s*\{[^}]*background:\s*var\(--composer-picker-option-hover\);/u,
    )
    expect(styles).toMatch(
      /\.runtime-menu-shell \.runtime-menu-item\.active\s*\{[^}]*background:\s*var\(--composer-picker-option-active\);/u,
    )
    // Running keeps two independent entries: the stop button never depends on
    // the draft, and the supplementary send appears once there is input.
    expect(composerView).toContain('const hasPendingInput = input.trim().length > 0 || attachments.length > 0')
    expect(composerView).toContain('{loading && (')
    expect(composerView).toContain('className="send-round stop"')
    expect(composerView).toContain('const [stopping, setStopping] = useState(false)')
    expect(composerView).toContain('if (!loading) setStopping(false)')
    expect(composerView).toContain('disabled={stopping}')
    expect(composerView).toContain("const stopActionTip = stopping ? '正在停止当前任务' : stopTip")
    expect(composerView).toContain('{(!loading || hasPendingInput) && (')
    expect(composerView).toContain('disabled={!loading && !hasPendingInput}')
    expect(composerView).not.toContain('showStop')
    expect(composerView).not.toMatch(/className="send-round[^"]*composer-tab-control/u)
  })
})
