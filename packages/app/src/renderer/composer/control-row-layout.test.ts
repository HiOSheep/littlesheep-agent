import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('composer control row layout', () => {
  it('keeps controls on one shrinkable row without painting into adjacent controls', async () => {
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
    const narrowWindowStyles = styles.slice(styles.indexOf('@media (max-width: 860px)'))

    expect(styles).toMatch(/\.composer-controls\s*\{[^}]*min-width:\s*0;[^}]*flex-wrap:\s*nowrap;/u)
    expect(styles).toMatch(/\.composer-left\s*\{[^}]*flex:\s*1 1 auto;[^}]*flex-wrap:\s*nowrap;/u)
    expect(styles).toMatch(/\.composer-right\s*\{[^}]*flex:\s*0 1 auto;[^}]*flex-wrap:\s*nowrap;/u)
    expect(styles).toMatch(/\.workspace-context-chip\s*\{[^}]*width:\s*fit-content;[^}]*min-width:\s*0;[^}]*max-width:\s*min\(280px, 34vw\);[^}]*flex:\s*0 1 auto;[^}]*overflow:\s*hidden;/u)
    expect(styles).toMatch(/\.workspace-context-path\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*0 1 auto;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/u)
    expect(styles).toMatch(/\.runtime-picker\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*flex:\s*0 1 auto;/u)
    expect(styles).toMatch(/\.runtime-picker-trigger\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/u)
    expect(styles).toMatch(/\.mode-picker\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*0 1 auto;/u)
    expect(styles).toMatch(/\.mode-picker-trigger\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/u)
    expect(narrowWindowStyles).not.toMatch(/\.composer-controls\s*\{[^}]*flex-direction:\s*column;/u)
    expect(narrowWindowStyles).not.toMatch(/\.model-picker\s*\{[^}]*width:\s*100%;/u)
  })
})
