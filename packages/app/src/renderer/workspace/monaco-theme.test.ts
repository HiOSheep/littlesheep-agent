import { describe, expect, it } from 'vitest'
import { LITTLE_SHEEP_MONACO_THEME_DATA } from './monaco-theme'

describe('LittleSheep Monaco theme', () => {
  it('keeps the editor darker than the workspace surface and code text readable', () => {
    const background = LITTLE_SHEEP_MONACO_THEME_DATA.colors['editor.background']
    expect(background).toBe('#101010')

    const foregrounds = [
      LITTLE_SHEEP_MONACO_THEME_DATA.colors['editor.foreground'],
      LITTLE_SHEEP_MONACO_THEME_DATA.colors['editorLineNumber.foreground'],
      ...tokens('comment', 'keyword', 'string', 'number', 'type', 'function', 'tag'),
    ]

    for (const foreground of foregrounds) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('uses distinct syntax families instead of a muted monochrome palette', () => {
    const foregrounds = tokens('comment', 'keyword', 'string', 'number', 'type', 'function', 'tag')
    expect(new Set(foregrounds).size).toBe(foregrounds.length)
  })

  it('keeps editor surfaces neutral and primary syntax colours vivid', () => {
    const neutralSurfaces = [
      LITTLE_SHEEP_MONACO_THEME_DATA.colors['editor.background'],
      LITTLE_SHEEP_MONACO_THEME_DATA.colors['editor.lineHighlightBackground'],
      LITTLE_SHEEP_MONACO_THEME_DATA.colors['editorWidget.background'],
      LITTLE_SHEEP_MONACO_THEME_DATA.colors['editorSuggestWidget.selectedBackground'],
    ]
    for (const surface of neutralSurfaces) expect(isNeutralGray(surface)).toBe(true)

    const vividForegrounds = tokens('keyword.control', 'number', 'string', 'type', 'tag', 'invalid')
    for (const foreground of vividForegrounds) expect(colourSaturation(foreground)).toBeGreaterThanOrEqual(0.7)
  })

  it('uses distinct red and green review surfaces from the shared theme', () => {
    const inserted = LITTLE_SHEEP_MONACO_THEME_DATA.colors['diffEditor.insertedLineBackground']
    const removed = LITTLE_SHEEP_MONACO_THEME_DATA.colors['diffEditor.removedLineBackground']
    expect(inserted).toMatch(/^#153F2B/iu)
    expect(removed).toMatch(/^#4B2025/iu)
    expect(inserted).not.toBe(removed)
  })
})

function tokens(...names: string[]): string[] {
  return names.map((name) => {
    const foreground = LITTLE_SHEEP_MONACO_THEME_DATA.rules.find((rule) => rule.token === name)?.foreground
    if (!foreground) throw new Error(`Missing Monaco theme token: ${name}`)
    return `#${foreground}`
  })
}

function contrastRatio(foreground: string, background: string): number {
  const bright = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (bright + 0.05) / (dark + 0.05)
}

function relativeLuminance(hex: string): number {
  const linearChannels = rgb(hex).map((channel) => (
    channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ))
  const red = linearChannels[0]!
  const green = linearChannels[1]!
  const blue = linearChannels[2]!
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function isNeutralGray(hex: string): boolean {
  const [red, green, blue] = rgb(hex)
  return red === green && green === blue
}

function colourSaturation(hex: string): number {
  const [red = 0, green = 0, blue = 0] = rgb(hex)
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  if (maximum === minimum) return 0
  const lightness = (maximum + minimum) / 2
  return (maximum - minimum) / (1 - Math.abs(2 * lightness - 1))
}

function rgb(hex: string): number[] {
  const channels = hex.slice(1, 7).match(/.{2}/gu)?.map((channel) => Number.parseInt(channel, 16) / 255)
  if (!channels || channels.length !== 3) throw new Error(`Invalid colour: ${hex}`)
  return channels
}
