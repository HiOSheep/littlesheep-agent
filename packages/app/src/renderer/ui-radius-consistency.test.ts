import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'


const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8')


describe('UI radius consistency', () => {
  it('uses the workspace corner as the shared rounded-rectangle baseline', () => {
    expect(styles).toContain('--radius-ui: 10px;')
    expect(styles).toContain('--radius-composer: 12px;')
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
      'var(--radius-ui)',
      'var(--radius-composer)',
      'var(--radius-icon)',
      'var(--radius-pill)',
      'var(--radius-circle)',
      '0',
    ]))

    expect(styles).toContain('--radius-icon: 3px;')
  })

  it('matches the composer corner radius to the 24px send button radius', () => {
    expect(styles).toMatch(/\.composer\s*\{[^}]*border-radius:\s*var\(--radius-composer\);/u)
    expect(styles).toMatch(/\.send-round\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*border-radius:\s*var\(--radius-circle\);/u)
  })
})
