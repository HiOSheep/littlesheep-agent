import { readFile } from 'node:fs/promises'
import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'


describe('workspace chip remove control', () => {
  it('uses a centered SVG close icon instead of a baseline-aligned text glyph', async () => {
    const source = await readFile(new URL('./workspace-chip.tsx', import.meta.url), 'utf8')
    const styles = await readRendererStyleSource()

    expect(source).toContain('<CloseIcon />')
    expect(source).not.toMatch(/>\s*×\s*</u)
    expect(styles).toMatch(/\.workspace-context-remove\s*\{[\s\S]*?display:\s*grid;[\s\S]*?place-items:\s*center;[\s\S]*?width:\s*18px;[\s\S]*?height:\s*18px;[\s\S]*?font-size:\s*0;[\s\S]*?line-height:\s*0;/u)
    expect(styles).toMatch(/\.workspace-context-remove \.sidebar-svg-icon\s*\{[^}]*width:\s*10px;[^}]*height:\s*10px;/u)
  })

  it('sizes to its path content without consuming the remaining control row', async () => {
    const styles = await readRendererStyleSource()

    expect(styles).toMatch(/\.workspace-context-chip\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*min\(280px, 34vw\);[^}]*flex:\s*0 1000 max-content;/u)
    expect(styles).toMatch(/\.workspace-context-chip\s*\{[^}]*min-width:\s*calc\(3em \+ 7px \+ var\(--composer-control-padding-inline\) \+ 28px\);/u)
    expect(styles).toMatch(/\.workspace-context-chip\s*\{[^}]*padding:\s*0 28px 0 var\(--composer-control-padding-inline\);/u)
    expect(styles).toMatch(/\.workspace-context-label\s*\{[^}]*min-width:\s*3em;[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/u)
    expect(styles).toMatch(/\.workspace-context-path\s*\{[^}]*flex:\s*0 1 auto;[^}]*text-overflow:\s*ellipsis;/u)
  })
})
