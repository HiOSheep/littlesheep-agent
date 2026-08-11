import { describe, expect, it } from 'vitest'
import { APPLICATION_ZOOM_FACTOR, isApplicationZoomShortcut } from './application-zoom.js'

function zoomInput(overrides: Partial<Parameters<typeof isApplicationZoomShortcut>[0]> = {}) {
  return {
    type: 'keyDown',
    key: '-',
    code: 'Minus',
    control: true,
    meta: false,
    alt: false,
    ...overrides,
  }
}

describe('application zoom policy', () => {
  it('locks the unadapted application layout to 100%', () => {
    expect(APPLICATION_ZOOM_FACTOR).toBe(1)
  })

  it.each([
    ['minus', { key: '-', code: 'Minus' }],
    ['equal alias for plus', { key: '=', code: 'Equal' }],
    ['shifted plus', { key: '+', code: 'Equal' }],
    ['reset', { key: '0', code: 'Digit0' }],
    ['keypad minus', { key: '-', code: 'NumpadSubtract' }],
    ['keypad plus', { key: '+', code: 'NumpadAdd' }],
    ['keypad reset', { key: '0', code: 'Numpad0' }],
  ])('blocks Ctrl+%s', (_label, overrides) => {
    expect(isApplicationZoomShortcut(zoomInput(overrides))).toBe(true)
  })

  it('also blocks the platform command modifier', () => {
    expect(isApplicationZoomShortcut(zoomInput({ control: false, meta: true }))).toBe(true)
  })

  it.each([
    ['an unmodified minus key', { control: false }],
    ['an unrelated Ctrl shortcut', { key: 's', code: 'KeyS' }],
    ['an AltGr-style chord', { alt: true }],
    ['a key release', { type: 'keyUp' }],
  ])('allows %s', (_label, overrides) => {
    expect(isApplicationZoomShortcut(zoomInput(overrides))).toBe(false)
  })
})
