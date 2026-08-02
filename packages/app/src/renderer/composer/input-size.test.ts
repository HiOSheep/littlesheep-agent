import { describe, expect, it } from 'vitest'
import {
  COMPOSER_INPUT_MIN_HEIGHT,
  clampComposerInputHeight,
  getComposerInputMaxHeight,
  syncComposerInputHeight,
} from './input-size'


function createTextarea(value: string, scrollHeight: number, initialHeight = '220px') {
  const style = { height: initialHeight, overflowY: 'auto' }
  const textarea = { value, scrollHeight, style } as unknown as HTMLTextAreaElement
  return { style, textarea }
}


describe('composer input sizing', () => {
  it('keeps the viewport-derived cap inside the supported range', () => {
    expect(getComposerInputMaxHeight(1024)).toBe(220)
    expect(getComposerInputMaxHeight(480)).toBe(144)
    expect(getComposerInputMaxHeight(240)).toBe(96)
  })

  it('clamps measured content between the compact baseline and viewport cap', () => {
    expect(clampComposerInputHeight(12, 220)).toBe(COMPOSER_INPUT_MIN_HEIGHT)
    expect(clampComposerInputHeight(84.2, 220)).toBe(85)
    expect(clampComposerInputHeight(480, 144)).toBe(144)
  })

  it('resets an empty input instead of preserving a stale maximum-height measurement', () => {
    const { style, textarea } = createTextarea('', 220)

    syncComposerInputHeight(textarea, 220)

    expect(style.height).toBe('36px')
    expect(style.overflowY).toBe('hidden')
  })

  it('grows only for real content and enables scrolling at the cap', () => {
    const compact = createTextarea('hello', 24)
    syncComposerInputHeight(compact.textarea, 220)
    expect(compact.style.height).toBe('36px')
    expect(compact.style.overflowY).toBe('hidden')

    const long = createTextarea('long content', 480)
    syncComposerInputHeight(long.textarea, 144)
    expect(long.style.height).toBe('144px')
    expect(long.style.overflowY).toBe('auto')
  })

  it('clears a stale inline height before reading wrapped content height', () => {
    const style = { height: '220px', overflowY: 'auto' }
    const textarea = {
      value: 'wrapped content',
      style,
      get scrollHeight() {
        return style.height === '0px' ? 72 : 220
      },
    } as unknown as HTMLTextAreaElement

    syncComposerInputHeight(textarea, 220)

    expect(style.height).toBe('72px')
    expect(style.overflowY).toBe('hidden')
  })
})
