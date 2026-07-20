import { describe, expect, it } from 'vitest'
import { shouldFocusComposerInput } from './focus-routing'

function targetWithMatch(match: boolean): EventTarget {
  return {
    closest: () => match ? {} : null,
  } as unknown as EventTarget
}

describe('composer input focus routing', () => {
  it('focuses the textarea when a blank part of the composer is clicked', () => {
    expect(shouldFocusComposerInput(targetWithMatch(false))).toBe(true)
  })

  it('preserves the native action for controls and the textarea itself', () => {
    expect(shouldFocusComposerInput(targetWithMatch(true))).toBe(false)
  })

  it('ignores event targets that cannot be matched safely', () => {
    expect(shouldFocusComposerInput(null)).toBe(false)
    expect(shouldFocusComposerInput({} as EventTarget)).toBe(false)
  })
})
