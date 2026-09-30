import { describe, expect, it } from 'vitest'
import { mermaidThemeVariables } from './Markdown'

describe('Mermaid appearance theme', () => {
  it('provides readable light and dark chart variables without changing semantic shapes', () => {
    const dark = mermaidThemeVariables(true)
    const light = mermaidThemeVariables(false)
    expect(dark.primaryTextColor).toBe('#f4f4f4')
    expect(dark.primaryColor).toBe('#2f2f2f')
    expect(light.primaryTextColor).toBe('#30302e')
    expect(light.primaryColor).toBe('#ffffff')
    expect(light.background).toBe('transparent')
    expect(light.lineColor).not.toBe(dark.lineColor)
  })
})
