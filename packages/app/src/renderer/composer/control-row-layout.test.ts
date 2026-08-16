import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('composer control row layout', () => {
  it('keeps the outer control centers on the 45-degree corner axes', async () => {
    const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8')
    const composerRule = styles.match(/\.composer\s*\{([^}]*)\}/u)?.[1] ?? ''
    const controlsRule = styles.match(/\.composer-controls\s*\{([^}]*)\}/u)?.[1] ?? ''
    const addMenuRule = styles.match(/\.add-menu\s*\{([^}]*)\}/u)?.[1] ?? ''
    const runActionsRule = styles.match(/\.composer-run-actions\s*\{([^}]*)\}/u)?.[1] ?? ''
    const narrowWindowStyles = styles.slice(styles.indexOf('@container chat-pane (max-width: 520px)'))

    expect(composerRule).toContain('--composer-padding-block: 10px;')
    expect(composerRule).toContain('--composer-padding-inline: 12px;')
    expect(composerRule).toContain('--composer-control-surface-size: 34px;')
    expect(composerRule).toContain('--composer-control-padding-inline: 10px;')
    expect(composerRule).toContain('--composer-control-row-height: 34px;')
    expect(composerRule).toContain('--composer-control-row-half-height: 17px;')
    expect(composerRule).toContain('--composer-leading-control-half-size: 17px;')
    expect(composerRule).toContain('--composer-trailing-control-half-size: 12px;')
    expect(composerRule).toMatch(
      /--composer-control-center-inset:\s*calc\(\s*var\(--composer-padding-block\)\s*\+\s*var\(--composer-control-row-half-height\)\s*\);/u,
    )
    expect(composerRule).toContain(
      'padding: var(--composer-padding-block) var(--composer-padding-inline);',
    )
    expect(controlsRule).toContain('min-height: var(--composer-control-row-height);')
    expect(controlsRule).toContain('transform: translateY(4px);')
    expect(addMenuRule).toMatch(
      /margin-left:\s*calc\(\s*var\(--composer-control-center-inset\)\s*-\s*var\(--composer-padding-inline\)\s*-\s*var\(--composer-leading-control-half-size\)\s*\);/u,
    )
    expect(runActionsRule).toMatch(
      /margin-right:\s*calc\(\s*var\(--composer-control-center-inset\)\s*-\s*var\(--composer-padding-inline\)\s*-\s*var\(--composer-trailing-control-half-size\)\s*\);/u,
    )
    expect(styles).toMatch(
      /\.icon-btn\s*\{[^}]*width:\s*var\(--composer-control-surface-size\);/u,
    )
    expect(styles).toMatch(/\.send-round\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/u)
    expect(styles).toMatch(
      /\.composer-run-actions\s*>\s*\.send-round:last-child:hover:not\(:disabled\)\s*\{[^}]*transform:\s*translate\(-1px, -1px\);/u,
    )
    expect(narrowWindowStyles).toMatch(
      /\.composer\s*\{[^}]*--composer-control-surface-size:\s*28px;[^}]*--composer-control-padding-inline:\s*8px;[^}]*--composer-leading-control-half-size:\s*14px;/u,
    )
  })

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
