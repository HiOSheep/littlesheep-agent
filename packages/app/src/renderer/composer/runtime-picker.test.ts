import { readFile } from 'node:fs/promises'
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
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
    const source = await readFile(new URL('./runtime-picker.tsx', import.meta.url), 'utf8')
    const compactComposerStyles = styles.slice(
      styles.indexOf('@container chat-pane (max-width: 520px)'),
      styles.indexOf('@media (max-width: 860px)'),
    )

    expect(styles).toMatch(/\.send-round\s*\{[\s\S]*?width: 24px;[\s\S]*?height: 24px;/u)
    expect(styles).toMatch(/@container chat-pane \(max-width: 520px\)[\s\S]*?\.composer-controls\s*\{[\s\S]*?flex-direction: row;[\s\S]*?flex-wrap: nowrap;/u)
    expect(compactComposerStyles).toMatch(/\.runtime-picker\s*\{[\s\S]*?width: fit-content;[\s\S]*?flex: 0 1 auto;/u)
    expect(compactComposerStyles).toMatch(/\.runtime-picker-trigger\s*\{[\s\S]*?width: max-content;[\s\S]*?max-width: 100%;/u)
    expect(compactComposerStyles).toMatch(/\.runtime-picker-model\s*\{[\s\S]*?flex: 0 1 auto;[\s\S]*?text-align: center;/u)
    expect(styles).not.toContain('width: min(100%, 340px)')
    expect(styles).not.toContain('flex: 1 1 260px')
    expect(styles).toMatch(/\.runtime-menu-shell\s*\{[\s\S]*?position: fixed;[\s\S]*?z-index: 2200;/u)
    expect(styles).toMatch(/\.runtime-menu-shell \.runtime-submenu\s*\{[\s\S]*?left: calc\(100% \+ 8px\);[\s\S]*?right: auto;/u)
    expect(styles).toMatch(/\.runtime-menu-shell \.runtime-model-menu\s*\{[\s\S]*?width: min\(143px, var\(--runtime-submenu-width, 220px\)\);/u)
    expect(styles).toMatch(/\.runtime-menu-shell \.runtime-provider-menu\s*\{[\s\S]*?width: min\(220px, var\(--runtime-submenu-width, 220px\)\);/u)
    expect(styles).not.toContain('scrollbar-gutter: stable')
    expect(styles).toMatch(/\.runtime-model-option > span:not\(\.runtime-menu-check\):not\(\.runtime-submenu-arrow\)/u)
    expect(styles).toMatch(/\.runtime-menu-check,[\s\S]*?flex: 0 0 16px;/u)
    expect(styles).not.toMatch(/@container chat-pane \(max-width: 640px\)/u)
    expect(source).toContain("onClick={() => openRuntimeSubmenu('model')}")
    expect(source).toContain("onClick={() => openRuntimeSubmenu('provider')}")
    expect(source).not.toContain("value === 'model' ? null : 'model'")
    expect(source).not.toContain("value === 'provider' ? null : 'provider'")
    expect(source).toContain('const minimumSubmenuWidth = 143')
    expect(source).toContain('const maximumSubmenuWidth = 220')
    expect(source.match(/onMouseLeave=\{\(\) => scheduleRuntimeSubmenuClose/g)).toHaveLength(1)
  })
})
