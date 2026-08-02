import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'


describe('workspace chip remove control', () => {
  it('uses a centered SVG close icon instead of a baseline-aligned text glyph', async () => {
    const source = await readFile(new URL('./workspace-chip.tsx', import.meta.url), 'utf8')
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

    expect(source).toContain('<CloseIcon />')
    expect(source).not.toMatch(/>\s*×\s*</u)
    expect(styles).toMatch(/\.workspace-context-remove\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;[\s\S]*?font-size:\s*0;[\s\S]*?line-height:\s*0;/u)
    expect(styles).toMatch(/\.workspace-context-remove \.sidebar-svg-icon\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;/u)
  })

  it('sizes to its path content without consuming the remaining control row', async () => {
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')

    expect(styles).toMatch(/\.workspace-context-chip\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(280px, 34vw\);[^}]*flex:\s*0 1 auto;/u)
    expect(styles).toMatch(/\.workspace-context-path\s*\{[^}]*flex:\s*0 1 auto;[^}]*text-overflow:\s*ellipsis;/u)
  })
})
