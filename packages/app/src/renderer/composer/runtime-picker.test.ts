import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'
import { formatRuntimeModelLabel, splitModelRef } from './runtime-picker'

describe('runtime picker labels', () => {
  it('keeps the provider out of a model label when the model repeats it', () => {
    expect(formatRuntimeModelLabel('deepseek-v4-flash', 'deepseek', 'DeepSeek')).toBe('v4-flash')
    expect(formatRuntimeModelLabel('DEEPSEEK_v3', 'deepseek', 'DeepSeek')).toBe('v3')
  })

  it('keeps model names that do not repeat the provider', () => {
    expect(formatRuntimeModelLabel('gpt-5', 'openai', 'OpenAI')).toBe('gpt-5')
    expect(formatRuntimeModelLabel('claude-sonnet-4', 'anthropic', 'Anthropic')).toBe('claude-sonnet-4')
  })

  it('continues to split the runtime reference without changing its stored value', () => {
    expect(splitModelRef('deepseek/deepseek-v4-flash')).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
    })
  })

  it('keeps narrow composer controls aligned and opens submenus to the right', async () => {
    const styles = await readRendererStyleSource()
    const source = await readFile(new URL('./runtime-picker.tsx', import.meta.url), 'utf8')
    const composerSource = await readFile(new URL('../app-shell/composer-view.tsx', import.meta.url), 'utf8')
    const controllerSource = await readFile(new URL('../app-shell/runtime-actions.ts', import.meta.url), 'utf8')
    const compactComposerStyles = styles.slice(
      styles.indexOf('@container chat-pane (max-width: 520px)'),
      styles.indexOf('@media (max-width: 860px)'),
    )

    expect(styles).toMatch(/\.send-round\s*\{[\s\S]*?width: var\(--composer-send-size\);[\s\S]*?height: var\(--composer-send-size\);/u)
    expect(styles).toMatch(/\.send-round-icon\.send\s*\{[^}]*transform:\s*none;/u)
    expect(styles).toMatch(/@container chat-pane \(max-width: 520px\)[\s\S]*?\.composer-controls\s*\{[\s\S]*?flex-direction: row;[\s\S]*?flex-wrap: nowrap;/u)
    expect(compactComposerStyles).toMatch(/\.runtime-picker\s*\{[\s\S]*?width: var\(--runtime-picker-closed-width, max-content\);[\s\S]*?flex: 0 0 auto;/u)
    expect(compactComposerStyles).toMatch(/\.runtime-picker\.open\s*\{[\s\S]*?width: var\(--runtime-picker-open-width, 208px\);/u)
    expect(compactComposerStyles).toMatch(/\.runtime-picker-trigger\s*\{[\s\S]*?width: max-content;[\s\S]*?max-width: 100%;/u)
    expect(compactComposerStyles).toMatch(/\.runtime-picker-model\s*\{[\s\S]*?flex: 0 0 auto;[\s\S]*?text-align: left;/u)
    expect(styles).toMatch(
      /\.runtime-picker-trigger\.composer-tab-control,[\s\S]*?\.mode-picker-trigger\.composer-tab-control,[\s\S]*?\.workspace-context-chip\.composer-tab-control\s*\{[\s\S]*?height: 28px;/u,
    )
    expect(source).toMatch(
      /<span className="runtime-picker-label-group">[\s\S]*?runtime-picker-model[\s\S]*?runtime-picker-reasoning[\s\S]*?<\/span>/u,
    )
    expect(source).toContain("'--runtime-picker-open-width': `${menuPosition?.width ?? 208}px`")
    expect(source).toContain("'--runtime-picker-closed-width': closedWidth ? `${closedWidth}px` : undefined")
    expect(source).toContain('const width = trigger.getBoundingClientRect().width')
    expect(source).toContain('const renderedMenuPosition = menuPosition ??')
    expect(source).toMatch(/if \(!open\) \{[\s\S]*?updateMenuPosition\(\)[\s\S]*?return/u)
    expect(source).toContain('if (open) {')
    expect(styles).toMatch(
      /\.runtime-picker\s*\{[^}]*width:\s*var\(--runtime-picker-closed-width, max-content\);[^}]*transition:\s*width var\(--runtime-picker-transition\) var\(--motion-ease\);/u,
    )
    expect(styles).toMatch(
      /\.runtime-picker\.open\s*\{[^}]*width:\s*var\(--runtime-picker-open-width, 208px\);/u,
    )
    expect(styles).toMatch(
      /\.runtime-picker\.open \.runtime-picker-trigger\s*\{[^}]*width:\s*100%;/u,
    )
    expect(styles).toMatch(
      /\.runtime-picker\.open \.runtime-picker-trigger\s*\{[^}]*justify-content:\s*center;/u,
    )
    expect(styles).not.toMatch(
      /\.runtime-picker\.open \.runtime-picker-trigger::after\s*\{[^}]*position:\s*absolute/u,
    )
    expect(styles).toMatch(/\.runtime-picker\s*\{[^}]*flex:\s*0 0 auto;/u)
    expect(styles).toMatch(
      /\.runtime-picker:not\(\.open\):has\(\.runtime-picker-trigger:hover\),[\s\S]*?width:\s*calc\(var\(--runtime-picker-closed-width\) \+ var\(--runtime-picker-hover-extra-width\)\);/u,
    )
    expect(styles).toMatch(
      /\.runtime-picker:not\(\.open\):has\(\.runtime-picker-trigger:hover\) \.runtime-picker-trigger,[\s\S]*?\.runtime-picker:not\(\.open\):has\(\.runtime-picker-trigger:focus-visible\) \.runtime-picker-trigger\s*\{[^}]*width:\s*100%;/u,
    )
    expect(styles).toMatch(
      /\.composer-right:has\(\.runtime-picker\.open\),[\s\S]*?\.composer-right:has\(\.runtime-picker-trigger:focus-visible\)\s*\{[^}]*flex:\s*0 0 auto;/u,
    )
    expect(styles).toMatch(/:root\s*\{[\s\S]*?--runtime-picker-hover-extra-width:\s*18px;/u)
    expect(styles).toMatch(/:root\s*\{[\s\S]*?--runtime-picker-transition:\s*300ms;/u)
    expect(styles).toMatch(
      /\.runtime-picker-label-group\s*\{[\s\S]*?display: inline-flex;[\s\S]*?gap: var\(--picker-arrow-gap\);[\s\S]*?flex: 0 0 auto;/u,
    )
    expect(styles).toMatch(/\.runtime-picker-trigger\s*\{[\s\S]*?position:\s*relative;[\s\S]*?justify-content:\s*center;[\s\S]*?padding:\s*0 var\(--composer-control-padding-inline\);/u)
    expect(styles).toMatch(/\.runtime-picker-model\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?overflow:\s*visible;[\s\S]*?text-overflow:\s*clip;/u)
    expect(styles).not.toMatch(/\.runtime-picker-trigger:hover:not\(:disabled\) \.runtime-picker-label-group/u)
    expect(styles).not.toMatch(/\.runtime-picker\.open \.runtime-picker-label-group/u)
    expect(styles).not.toMatch(
      /\.runtime-picker-trigger:hover:not\(:disabled\) \.runtime-picker-model,[\s\S]*?\.runtime-picker-trigger:hover:not\(:disabled\) \.runtime-picker-reasoning/u,
    )
    expect(styles).not.toContain('width: min(100%, 340px)')
    expect(styles).not.toContain('flex: 1 1 260px')
    expect(styles).toMatch(/\.runtime-menu-shell\s*\{[\s\S]*?position: fixed;[\s\S]*?z-index: 2200;/u)
    expect(styles).toMatch(/\.runtime-menu-shell\s*\{[\s\S]*?width: 208px;/u)
    expect(styles).toMatch(
      /\.runtime-menu-shell\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?transition:[\s\S]*?opacity var\(--runtime-picker-transition\) var\(--motion-ease\),[\s\S]*?visibility 0s linear var\(--runtime-picker-transition\);/u,
    )
    expect(styles).toMatch(
      /\.runtime-menu-shell\.open\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?transition:[\s\S]*?opacity var\(--runtime-picker-transition\) var\(--motion-ease\),/u,
    )
    expect(styles).toMatch(
      /\.runtime-menu-shell:not\(\.open\)::before,[\s\S]*?\.runtime-menu-shell:not\(\.open\) \.runtime-submenu\s*\{[^}]*pointer-events:\s*none;/u,
    )
    expect(styles).toMatch(
      /\.runtime-menu-shell \.runtime-submenu\s*\{[\s\S]*?transition:[\s\S]*?opacity var\(--runtime-picker-transition\) var\(--motion-ease\),[\s\S]*?visibility 0s linear var\(--runtime-picker-transition\);/u,
    )
    expect(styles).toMatch(/\.runtime-menu-divider\s*\{[^}]*height:\s*1px;[^}]*margin:\s*2px 1px;/u)
    expect(styles).toMatch(/\.runtime-menu-list\s*\{[^}]*gap:\s*1px;/u)
    expect(styles).toMatch(/\.runtime-menu-item\s*\{[^}]*min-height:\s*32px;[^}]*gap:\s*6px;[^}]*padding:\s*0 7px;/u)
    expect(styles).toMatch(/\.runtime-menu-shell \.runtime-picker-panel\s*\{[\s\S]*?gap:\s*2px;[\s\S]*?padding:\s*5px;/u)
    expect(styles).toMatch(/\.runtime-menu-shell \.runtime-submenu\s*\{[\s\S]*?padding:\s*5px;/u)
    // The picker and its submenus are the composer's popovers: they take the input surface's
    // material from one shared rule (translucent fill, backdrop blur, no border strokes) instead
    // of an opaque fill each, so neither rule body owns a background or a border of its own.
    expect(styles).toMatch(
      /\.add-menu-panel,[\s\S]*?\.model-picker-panel,[\s\S]*?\.runtime-menu-shell \.runtime-picker-panel,[\s\S]*?\.runtime-menu-shell \.runtime-submenu\s*\{[^}]*background:\s*var\(--composer-surface\);[^}]*border:\s*0;[\s\S]*?backdrop-filter:\s*blur\(18px\) saturate\(135%\);/u,
    )
    for (const selector of ['\\.runtime-menu-shell \\.runtime-picker-panel', '\\.runtime-menu-shell \\.runtime-submenu']) {
      const body = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'u').exec(styles)?.[1] ?? ''
      expect(body).not.toContain('background')
    }
    expect(styles).toMatch(
      /\.runtime-menu-shell \.runtime-menu-item:hover:not\(:disabled\),[\s\S]*?\.runtime-menu-shell \.runtime-menu-item\.active\s*\{[^}]*background:\s*var\(--composer-picker-option-hover\);/u,
    )
    expect(styles).toMatch(/\.runtime-menu-shell \.runtime-section-title\s*\{[^}]*padding:\s*3px 7px 5px;/u)
    expect(styles).toMatch(
      /\.runtime-menu-item:hover:not\(:disabled\),[\s\S]*?\.runtime-menu-item\.active\s*\{[\s\S]*?border-color:\s*transparent;/u,
    )
    expect(styles).toMatch(
      /\.runtime-model-option\.active,[\s\S]*?\.runtime-reasoning-option\.active\s*\{[\s\S]*?border-color:\s*transparent;/u,
    )
    expect(styles).toMatch(/\.runtime-menu-shell \.runtime-submenu\s*\{[\s\S]*?left: calc\(100% \+ 8px\);[\s\S]*?right: auto;/u)
    expect(styles).toMatch(/\.runtime-menu-shell \.runtime-model-menu\s*\{[\s\S]*?width: min\(143px, var\(--runtime-submenu-width, 220px\)\);/u)
    expect(styles).toMatch(/\.runtime-menu-shell \.runtime-provider-menu\s*\{[\s\S]*?width: min\(220px, var\(--runtime-submenu-width, 220px\)\);/u)
    expect(styles).not.toMatch(/\.runtime-menu-shell(?:\s+[^,{]+)?\s*\{[^}]*scrollbar-gutter:\s*stable/u)
    expect(styles).toMatch(/\.runtime-model-option > span:not\(\.runtime-menu-check\):not\(\.runtime-submenu-arrow\)/u)
    expect(styles).toMatch(/\.runtime-menu-check,[\s\S]*?flex: 0 0 14px;/u)
    expect(styles).toMatch(/\.runtime-menu-shell::before\s*\{[\s\S]*?width:\s*8px;/u)
    expect(styles).not.toMatch(/@container chat-pane \(max-width: 640px\)/u)
    expect(source).toContain("onClick={() => openRuntimeSubmenu('model')}")
    expect(source).toContain("onClick={() => openRuntimeSubmenu('provider')}")
    expect(source).not.toContain('title={model}')
    expect(source).not.toContain('title={selected?.model}')
    expect(source).toContain('aria-label={`模型 ${modelLabel}, 推理 ${reasoningOption?.label ?? effectiveReasoning}`}')
    expect(composerSource).toContain('applyModelPatch({')
    expect(controllerSource).toMatch(
      /function applyModelPatch\([\s\S]*?setRuntime\(\(current\) => current \? \{ \.\.\.current, \.\.\.patch \} : current\)[\s\S]*?void flushModelPatchQueue\(\)/u,
    )
    expect(controllerSource).toContain('const next = await updateRuntime(patch)')
    expect(controllerSource).toContain('latest.requestId !== requestId')
    expect(source).not.toContain("value === 'model' ? null : 'model'")
    expect(source).not.toContain("value === 'provider' ? null : 'provider'")
    expect(source).toContain('const minimumSubmenuWidth = 143')
    expect(source).toContain('const maximumSubmenuWidth = 220')
    expect(source).toContain('const minimumMenuWidth = 176')
    expect(source).toContain('const maximumMenuWidth = 208')
    expect(source.match(/onMouseLeave=\{\(\) => scheduleRuntimeSubmenuClose/g)).toHaveLength(1)
  })
})
