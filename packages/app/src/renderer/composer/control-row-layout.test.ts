import { readRendererStyleSource } from '../style-source-test-utils'
import { describe, expect, it } from 'vitest'

describe('composer control row layout', () => {
  it('keeps the outer control centers on the 45-degree corner axes', async () => {
    const styles = await readRendererStyleSource()
    const composerRule = styles.match(/\.composer\s*\{([^}]*)\}/u)?.[1] ?? ''
    const controlsRule = styles.match(/\.composer-controls\s*\{([^}]*)\}/u)?.[1] ?? ''
    const addMenuRule = styles.match(/\.add-menu\s*\{([^}]*)\}/u)?.[1] ?? ''
    const runActionsRule = styles.match(/\.composer-run-actions\s*\{([^}]*)\}/u)?.[1] ?? ''
    const sendButtonRule = styles.match(/\.send-round\s*\{([^}]*)\}/u)?.[1] ?? ''
    const narrowWindowStyles = styles.slice(styles.indexOf('@container chat-pane (max-width: 520px)'))

    expect(composerRule).toContain('--composer-padding-block: 10px;')
    expect(composerRule).toContain('--composer-padding-inline: 12px;')
    expect(composerRule).toContain('--composer-control-surface-size: 34px;')
    expect(composerRule).toContain('--composer-control-padding-inline: 10px;')
    expect(composerRule).toContain('--composer-control-row-height: 34px;')
    expect(composerRule).toContain('--composer-control-row-half-height: 17px;')
    expect(composerRule).toContain('--composer-control-gap: 3px;')
    expect(composerRule).toContain('--composer-control-font-size: 12px;')
    expect(composerRule).toContain('--composer-leading-control-half-size: 17px;')
    expect(composerRule).toContain('--composer-trailing-control-half-size: 17px;')
    expect(composerRule).toContain('--composer-send-size: 30px;')
    expect(composerRule).toMatch(
      /--mode-picker-compact-width:\s*calc\(\s*16px \+ 7px \+ \(2 \* var\(--composer-control-padding-inline\)\)\s*\);/u,
    )
    expect(styles).toMatch(/:root\s*\{[\s\S]*?--chat-message-font-size:\s*14px;/u)
    expect(styles).toMatch(/\.message\s*\{[^}]*font-size:\s*var\(--chat-message-font-size\);/u)
    expect(styles).toMatch(
      /\.model-picker-trigger\s*\{[^}]*font-size:\s*var\(--composer-control-font-size\);/u,
    )
    expect(styles).toMatch(
      /\.option-picker \.model-picker-current\s*\{[^}]*font-size:\s*var\(--composer-control-font-size\);/u,
    )
    expect(styles).toMatch(
      /\.runtime-picker-trigger\s*\{[^}]*font-size:\s*var\(--composer-control-font-size\);/u,
    )
    expect(styles).toMatch(
      /\.workspace-context-chip\s*\{[^}]*font-size:\s*var\(--composer-control-font-size\);/u,
    )
    expect(composerRule).toMatch(
      /--composer-control-center-inset:\s*calc\(\s*var\(--composer-padding-block\)\s*\+\s*var\(--composer-control-row-half-height\)\s*\);/u,
    )
    expect(composerRule).toContain(
      'padding: var(--composer-padding-block) var(--composer-padding-inline);',
    )
    expect(controlsRule).toContain('min-height: var(--composer-control-row-height);')
    expect(controlsRule).toContain('gap: var(--composer-control-gap);')
    expect(controlsRule).toContain('transform: translateY(2px);')
    expect(addMenuRule).toMatch(
      /margin-left:\s*calc\(\s*var\(--composer-control-center-inset\)\s*-\s*var\(--composer-padding-inline\)\s*-\s*var\(--composer-leading-control-half-size\)\s*\);/u,
    )
    expect(runActionsRule).toMatch(
      /margin-right:\s*calc\(\s*var\(--composer-control-center-inset\)\s*-\s*var\(--composer-padding-inline\)\s*-\s*var\(--composer-trailing-control-half-size\)\s*\);/u,
    )
    expect(styles).toMatch(
      /\.icon-btn\s*\{[^}]*width:\s*var\(--composer-control-surface-size\);/u,
    )
    expect(styles).toMatch(
      /\.composer-left\s*\{[^}]*flex:\s*1 1 auto;[^}]*justify-content:\s*flex-start;/u,
    )
    expect(styles).toMatch(
      /\.composer-right\s*\{[^}]*margin-left:\s*auto;[^}]*justify-content:\s*flex-end;/u,
    )
    expect(styles).toMatch(
      /\.composer-left,\s*\.composer-right\s*\{[^}]*gap:\s*var\(--composer-control-gap\);/u,
    )
    expect(styles).toMatch(
      /\.composer-run-actions\s*\{[^}]*gap:\s*var\(--composer-control-gap\);/u,
    )
    expect(sendButtonRule).toContain('width: var(--composer-send-size);')
    expect(sendButtonRule).toContain('height: var(--composer-send-size);')
    expect(sendButtonRule).toContain('flex: 0 0 var(--composer-send-size);')
    expect(sendButtonRule).toContain('transition: none;')
    expect(styles).toMatch(/\.send-round-icon\s*\{[^}]*width:\s*14px;[^}]*height:\s*14px;/u)
    expect(styles).toMatch(/\.send-round-icon\.send\s*\{[^}]*transform:\s*none;/u)
    expect(styles).not.toMatch(/\.send-round-icon\.send\s*\{[^}]*translateX\(/u)
    expect(styles).not.toMatch(/\.send-round:hover:not\(:disabled\)/u)
    expect(styles).not.toMatch(/\.composer-run-actions\s*>\s*\.send-round:last-child:hover/u)
    expect(narrowWindowStyles).toMatch(
      /\.composer\s*\{[^}]*--composer-control-surface-size:\s*28px;[^}]*--composer-control-padding-inline:\s*8px;[^}]*--composer-leading-control-half-size:\s*14px;/u,
    )
    expect(narrowWindowStyles).toMatch(
      /--mode-picker-compact-width:\s*calc\(\s*14px \+ 5px \+ \(2 \* var\(--composer-control-padding-inline\)\)\s*\);/u,
    )
  })

  it('keeps controls on one shrinkable row without painting into adjacent controls', async () => {
    const styles = await readRendererStyleSource()
    const narrowWindowStyles = styles.slice(styles.indexOf('@media (max-width: 860px)'))

    expect(styles).toMatch(/\.composer-controls\s*\{[^}]*min-width:\s*0;[^}]*flex-wrap:\s*nowrap;/u)
    expect(styles).toMatch(/\.composer-left\s*\{[^}]*flex:\s*1 1 auto;[^}]*flex-wrap:\s*nowrap;/u)
    expect(styles).toMatch(/\.composer-right\s*\{[^}]*flex:\s*0 1 auto;[^}]*flex-wrap:\s*nowrap;/u)
    expect(styles).toMatch(/\.workspace-context-chip\s*\{[^}]*width:\s*max-content;[^}]*min-width:\s*calc\(3em \+ 7px \+ var\(--composer-control-padding-inline\) \+ 28px\);[^}]*max-width:\s*min\(280px, 34vw\);[^}]*flex:\s*0 1000 max-content;[^}]*overflow:\s*hidden;/u)
    expect(styles).toMatch(/\.workspace-context-path\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*0 1 auto;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/u)
    expect(styles).toMatch(/\.runtime-picker\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*flex:\s*0 0 auto;/u)
    expect(styles).toMatch(/\.runtime-picker-trigger\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/u)
    expect(styles).toMatch(/\.mode-picker\s*\{[^}]*min-width:\s*var\(--mode-picker-compact-width\);[^}]*width:\s*max-content;[^}]*flex:\s*0 1 max-content;/u)
    expect(styles).toMatch(/\.mode-picker-trigger\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/u)
    expect(styles).toMatch(/\.mode-picker-content\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*hidden;/u)
    expect(styles).toMatch(/\.option-picker \.model-picker-current\s*\{[^}]*flex:\s*1 1 auto;/u)
    expect(styles).toMatch(/\.workspace-context-chip\s*\{[^}]*min-width:\s*calc\(3em \+ 7px \+ var\(--composer-control-padding-inline\) \+ 28px\);/u)
    expect(styles).toMatch(/\.workspace-context-label\s*\{[^}]*min-width:\s*3em;[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/u)
    expect(narrowWindowStyles).not.toMatch(/\.composer-controls\s*\{[^}]*flex-direction:\s*column;/u)
    expect(narrowWindowStyles).not.toMatch(/\.model-picker\s*\{[^}]*width:\s*100%;/u)
    expect(narrowWindowStyles).not.toMatch(/\.runtime-picker-trigger\s*\{[^}]*font-size:\s*11px;/u)
  })
})
