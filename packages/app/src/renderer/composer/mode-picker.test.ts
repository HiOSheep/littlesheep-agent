import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { requiresFullAccessConfirmation } from './mode-picker'

describe('mode picker layout', () => {
  it('keeps the permission menu at half the shared option-menu width', async () => {
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

    expect(styles).toMatch(
      /\.option-picker-panel\.mode-picker-panel\s*\{[^}]*width:\s*min\(160px, calc\(100vw - 24px\)\);/u,
    )
    expect(styles).toMatch(
      /\.mode-picker-panel \.option-picker-list\s*\{[^}]*display:\s*grid;[^}]*gap:\s*4px;/u,
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
  })
})
