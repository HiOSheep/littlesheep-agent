import { readRendererStyleSource } from './style-source-test-utils'
import { describe, expect, it } from 'vitest'


const styles = await readRendererStyleSource()


describe('UI radius consistency', () => {
  it('uses the workspace corner as the shared rounded-rectangle baseline', () => {
    expect(styles).toContain('--radius-ui: 10px;')
    expect(styles).toContain('--radius-card: 18px;')
    expect(styles).toContain('--radius-message-bubble: 22px;')
    expect(styles).toContain('--radius-floating-panel: 14px;')
    expect(styles).toContain('--floating-panel-inner-radius: calc(')
    expect(styles).toContain('--radius-composer: 14px;')
    expect(styles).toContain('--radius-composer-input: 28px;')
    expect(styles).toContain('--radius-icon: 3px;')
    expect(styles).toContain('--radius-pill: 999px;')
    expect(styles).toContain('--radius-circle: 50%;')
  })

  it('uses only semantic radius tokens or an explicit square corner', () => {
    const values = [...styles.matchAll(
      /^\s*border(?:-(?:top-left|top-right|bottom-left|bottom-right))?-radius:\s*([^;]+);/gmu,
    )].map((match) => match[1]!.trim())

    expect(values.length).toBeGreaterThan(0)
    expect(new Set(values)).toEqual(new Set([
      '11px',
      '18px',
      'var(--settings-card-radius)',
      'var(--settings-control-radius)',
      '12px',
      'var(--radius-ui)',
      'var(--radius-card)',
      'var(--radius-message-bubble)',
      'var(--radius-floating-panel)',
      'var(--floating-panel-inner-radius)',
      'var(--radius-composer-input)',
      // The composer control row's own corner: the composer's rounding, capped short of a capsule so
      // the compact row cannot turn its boxes into pills.
      'var(--composer-control-radius)',
      'var(--radius-icon)',
      'var(--radius-pill)',
      'var(--radius-circle)',
      'var(--selection-radius)',
      '0',
    ]))

    expect(styles).toContain('--radius-icon: 3px;')
  })

  it('keeps the enlarged send button circular', () => {
    expect(styles).toMatch(/\.composer\s*\{[^}]*border-radius:\s*var\(--radius-composer-input\);/u)
    // DSH's send control is the composer's primary action at 34px.
    expect(styles).toContain('--composer-send-size: 34px;')
    expect(styles).toMatch(/\.send-round\s*\{[^}]*width:\s*var\(--composer-send-size\);[^}]*height:\s*var\(--composer-send-size\);[^}]*border-radius:\s*var\(--radius-pill\);/u)
  })
})
