import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'
import { requiresFullAccessConfirmation } from './mode-picker'

describe('mode picker layout', () => {
  it('leaves the scrolling option list room for the focus ring it clips', async () => {
    const styles = await readRendererStyleSource()

    // The list scrolls, so it clips its contents at its padding box, while the app-wide focus
    // ring is drawn 2px *outside* each option's border box (`outline-offset: 2px`, 2px wide).
    // With `padding: 0` the ring's left, right and top sides were cut away - measured on a
    // focused option whose outline resolved correctly and whose per-side coverage was still
    // 0 / 0 / 0. This is the fix for "the focused permission option is ring-less".
    const list = /\.mode-picker-panel \.option-picker-list\s*\{([^}]*)\}/u.exec(styles)?.[1]
    expect(list, 'the mode picker list rule is missing').toBeDefined()
    const padding = /(?:^|[\s;{])padding:\s*([^;]+);/u.exec(list!)?.[1]?.trim()
    expect(padding, 'the list must state a padding').toBeDefined()
    // Every longhand the ring needs room against, so `2px 0` cannot pass as "has padding".
    const values = padding!.split(/\s+/u).map((value) => Number.parseFloat(value))
    const [block = 0, inline = block] = values
    const sidesClearRing = [values[0] ?? 0, inline, values[2] ?? block, values[3] ?? inline]
    expect(
      sidesClearRing.every((value) => Number.isFinite(value) && value >= 2),
      `the list clips the focus ring on a side with less padding than the ring's 2px reach (padding: ${padding})`,
    ).toBe(true)
    expect(block, 'the padding is the ring reach and nothing more').toBeLessThanOrEqual(4)
  })

  it('keeps the permission menu at half the shared option-menu width', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(
      /\.option-picker-panel\.mode-picker-panel\s*\{[^}]*width:\s*min\(280px, calc\(100vw - 24px\)\);/u,
    )
    expect(styles).toMatch(
      /\.model-picker-panel\s*\{[\s\S]*?border:\s*0;/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-panel \.option-picker-list\s*\{[^}]*display:\s*grid;[^}]*gap:\s*1px;[^}]*padding:\s*2px;/u,
    )
    // The permission menu is one of the composer's popovers: it shares the input surface's
    // material (translucent fill, backdrop blur, no border strokes) instead of an opaque fill of
    // its own. The shared rule owns that material, so this panel body only carries geometry.
    expect(styles).toMatch(
      /\.option-picker-panel\.mode-picker-panel\s*\{[^}]*padding:\s*5px;[^}]*\}/u,
    )
    expect(/\.option-picker-panel\.mode-picker-panel\s*\{([^}]*)\}/u.exec(styles)?.[1] ?? '')
      .not.toContain('background')
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
