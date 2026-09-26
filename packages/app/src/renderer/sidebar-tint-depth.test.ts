// The sidebar's wash is a tint, not a colour: it may cool the card, but it must not turn it into a
// coloured panel. The first pass ran at 16% / 19% and read as exactly that; this pins the shallow
// range so a later "make it prettier" cannot quietly bring the heavy version back.
import { describe, expect, it } from 'vitest'
import { readRendererStyleSource } from './style-source-test-utils'

const styles = await readRendererStyleSource()

function tokenAlpha(name: string): number {
  const match = new RegExp(`${name}:\\s*rgba\\(\\s*\\d+,\\s*\\d+,\\s*\\d+,\\s*([\\d.]+)\\s*\\)`).exec(styles)
  expect(match, `${name} must be an rgba token`).not.toBeNull()
  return Number(match![1])
}

describe('sidebar tint depth', () => {
  it('keeps the wash shallow at both ends', () => {
    const top = tokenAlpha('--sidebar-tint-top')
    const bottom = tokenAlpha('--sidebar-tint-bottom')
    expect(top).toBeGreaterThan(0)
    expect(bottom).toBeGreaterThan(0)
    expect(top).toBeLessThanOrEqual(0.1)
    expect(bottom).toBeLessThanOrEqual(0.12)
    // The violet end stays the stronger of the two, which is what gives the card its direction.
    expect(bottom).toBeGreaterThan(top)
  })

  it('paints it as one vertical wash over the sidebar surface only', () => {
    const start = styles.indexOf('.sidebar-surface::before {\n  background-image: linear-gradient(')
    expect(start, 'the wash is its own rule').toBeGreaterThan(-1)
    const body = styles.slice(start, styles.indexOf('}', start))
    expect(body).toContain('180deg,')
    expect(body).toContain('var(--sidebar-tint-top) 0%')
    expect(body).toContain('var(--sidebar-tint-bottom) 100%')
    // The workspace panel beside it keeps the plain glass: the wash is the sidebar's alone.
    expect(styles.slice(start, start + 80)).toContain('.sidebar-surface::before')
  })
})
