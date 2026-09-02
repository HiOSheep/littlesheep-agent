import { describe, expect, it } from 'vitest'
import { LITTLE_SHEEP_MONACO_THEME_DATA } from './monaco-theme'
import {
  LITTLE_SHEEP_SELECTION_BACKGROUND,
  LITTLE_SHEEP_SELECTION_BACKGROUND_INACTIVE,
  LITTLE_SHEEP_CODE_SELECTION_BACKGROUND,
  LITTLE_SHEEP_CODE_SELECTION_BACKGROUND_INACTIVE,
  LITTLE_SHEEP_SELECTION_FOREGROUND,
} from '../selection-style'

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

  it('uses the muted non-code selection palette', () => {
    expect(LITTLE_SHEEP_MONACO_THEME_DATA.colors['editor.selectionBackground'])
      .toBe(LITTLE_SHEEP_SELECTION_BACKGROUND)
    expect(LITTLE_SHEEP_MONACO_THEME_DATA.colors['editor.inactiveSelectionBackground'])
      .toBe(LITTLE_SHEEP_SELECTION_BACKGROUND_INACTIVE)
    expect(LITTLE_SHEEP_MONACO_THEME_DATA.colors['editor.selectionForeground'])
      .toBe(LITTLE_SHEEP_SELECTION_FOREGROUND)
    expect(LITTLE_SHEEP_CODE_SELECTION_BACKGROUND).toBe('#454545')
    expect(LITTLE_SHEEP_CODE_SELECTION_BACKGROUND_INACTIVE).toBe('#3A3A3A')
  })

  it('composites one 50%-opaque review surface to the reference row tints', () => {
    const inserted = LITTLE_SHEEP_MONACO_THEME_DATA.colors['diffEditor.insertedLineBackground']
    const removed = LITTLE_SHEEP_MONACO_THEME_DATA.colors['diffEditor.removedLineBackground']

    expect(inserted).toBe('#23452780')
    expect(removed).toBe('#5D291D80')
    expect(alpha(inserted)).toBe(0x80)
    expect(alpha(removed)).toBe(0x80)
    expect(compositeOver(inserted, '#101010')).toBe('#1A2B1C')
    expect(compositeOver(removed, '#101010')).toBe('#371D17')
    expect(inserted).not.toBe(removed)
  })

  it('keeps character and gutter overlays transparent so each row has only one tint', () => {
    const insertedText = LITTLE_SHEEP_MONACO_THEME_DATA.colors['diffEditor.insertedTextBackground']
    const removedText = LITTLE_SHEEP_MONACO_THEME_DATA.colors['diffEditor.removedTextBackground']

    expect(insertedText).toBe('#00000000')
    expect(removedText).toBe('#00000000')
    expect(LITTLE_SHEEP_MONACO_THEME_DATA.colors).not.toHaveProperty('diffEditor.insertedTextBorder')
    expect(LITTLE_SHEEP_MONACO_THEME_DATA.colors).not.toHaveProperty('diffEditor.removedTextBorder')
    expect(LITTLE_SHEEP_MONACO_THEME_DATA.colors['diffEditorGutter.insertedLineBackground']).toBe('#00000000')
    expect(LITTLE_SHEEP_MONACO_THEME_DATA.colors['diffEditorGutter.removedLineBackground']).toBe('#00000000')
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

function rgb(hex: string): [number, number, number] {
  const channels = hex.slice(1, 7).match(/.{2}/gu)?.map((channel) => Number.parseInt(channel, 16) / 255)
  if (!channels || channels.length !== 3) throw new Error(`Invalid colour: ${hex}`)
  return [channels[0]!, channels[1]!, channels[2]!]
}

function alpha(hex: string): number {
  return hex.length >= 9 ? Number.parseInt(hex.slice(7, 9), 16) : 255
}

function compositeOver(foreground: string, background: string): string {
  const foregroundChannels = rgb(foreground)
  const backgroundChannels = rgb(background)
  const opacity = alpha(foreground) / 255
  const channels = foregroundChannels.map((channel, index) => (
    Math.round((channel * opacity + backgroundChannels[index]! * (1 - opacity)) * 255)
  ))
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}
