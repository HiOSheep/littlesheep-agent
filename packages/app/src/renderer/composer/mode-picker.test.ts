import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'
import { requiresFullAccessConfirmation } from './mode-picker'

describe('mode picker layout', () => {
  it('keeps the permission menu at half the shared option-menu width', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(
      /\.option-picker-panel\.mode-picker-panel\s*\{[^}]*width:\s*min\(280px, calc\(100vw - 24px\)\);/u,
    )
    expect(styles).toMatch(
      /\.model-picker-panel\s*\{[\s\S]*?border:\s*0;/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-panel \.option-picker-list\s*\{[^}]*display:\s*grid;[^}]*gap:\s*1px;[^}]*padding:\s*0;/u,
    )
    expect(styles).toMatch(
      /\.option-picker-panel\.mode-picker-panel\s*\{[^}]*padding:\s*5px;[^}]*background:\s*var\(--control-hover\);/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-panel \.model-option\s*\{[^}]*min-height:\s*54px;[^}]*gap:\s*6px;[^}]*padding:\s*7px;[^}]*border-color:\s*transparent;[^}]*align-items:\s*start;[^}]*display:\s*grid;[^}]*grid-template-columns:\s*16px minmax\(0, 1fr\);/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-panel \.model-option\.active\s*\{[^}]*background:\s*var\(--composer-picker-option-active\);[^}]*border-color:\s*transparent;/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-panel \.mode-option-copy\s*\{[^}]*display:\s*grid;[^}]*gap:\s*2px;/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-panel \.mode-option-copy small\s*\{[^}]*color:\s*var\(--muted-2\);[^}]*font-size:\s*11px;[^}]*white-space:\s*normal;/u,
    )
    expect(styles).toMatch(
      /\.full-access-warning\s*\{[^}]*border:\s*0;/u,
    )
    expect(styles).toMatch(
      /\.full-access-warning \.approval-action\s*\{[^}]*border:\s*0;/u,
    )
    expect(styles).toMatch(
      /\.full-access-warning \.approval-action\.primary\.danger\s*\{[^}]*color:\s*#2b0b0b;[^}]*background:\s*var\(--danger\);/u,
    )
  })

  it('requires one explicit warning before entering full access', async () => {
    expect(requiresFullAccessConfirmation('research', 'full')).toBe(true)
    expect(requiresFullAccessConfirmation('restricted', 'full')).toBe(true)
    expect(requiresFullAccessConfirmation('full', 'full')).toBe(false)
    expect(requiresFullAccessConfirmation('full', 'research')).toBe(false)

    const source = await readFile(new URL('./mode-picker.tsx', import.meta.url), 'utf8')
    expect(source).toContain('启用完全访问？')
    expect(source).toContain('approval-action primary danger')
    expect(source).toContain("onChange('full')")
    expect(source).toContain('className="mode-option-copy"')
    expect(source).toContain('<small>{item.desc}</small>')
    expect(source).not.toContain('FloatingHelpTooltip')
    expect(source).not.toContain('buildModeOptionTip')
  })
})
